// server.js - Main Express server
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Database setup (using lowdb for simplicity, use PostgreSQL in production)
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

await db.read();
db.data ||= { orders: [], uploads: [] };

// Email setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Product configuration
const PRODUCTS = {
  digital: { price: 7900, name: 'Digital Only', shippingRequired: false },
  print: { price: 18900, name: 'Fine-Art Print', shippingRequired: true },
  framed: { price: 39900, name: 'Framed Edition', shippingRequired: true }
};

const VIBES = {
  homeAlone: 'Home Alone',
  elf: 'Elf',
  vacation: 'Christmas Vacation'
};

// API Routes

// Upload photo
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploadData = {
      id: uuidv4(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    db.data.uploads.push(uploadData);
    await db.write();

    res.json({
      success: true,
      uploadId: uploadData.id,
      filename: uploadData.filename,
      url: `/uploads/${uploadData.filename}`
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Create Stripe checkout session
app.post('/api/create-checkout', async (req, res) => {
  try {
    const {
      vibe,
      tier,
      quantity,
      uploadId,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      notes
    } = req.body;

    // Validation
    if (!vibe || !tier || !quantity || !uploadId || !customerName || !customerEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!PRODUCTS[tier]) {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    if (!VIBES[vibe]) {
      return res.status(400).json({ error: 'Invalid vibe' });
    }

    const product = PRODUCTS[tier];
    const totalAmount = product.price * quantity;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${VIBES[vibe]} - ${product.name}`,
              description: `Custom holiday movie poster`,
            },
            unit_amount: product.price,
          },
          quantity: quantity,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
      customer_email: customerEmail,
      metadata: {
        orderId: uuidv4(),
        vibe,
        tier,
        quantity: quantity.toString(),
        uploadId,
        customerName,
        customerPhone: customerPhone || '',
        shippingAddress: shippingAddress || '',
        notes: notes || ''
      }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Create order record
    const order = {
      id: session.metadata.orderId,
      stripeSessionId: session.id,
      stripePaymentIntent: session.payment_intent,
      vibe: session.metadata.vibe,
      tier: session.metadata.tier,
      quantity: parseInt(session.metadata.quantity),
      uploadId: session.metadata.uploadId,
      customerName: session.metadata.customerName,
      customerEmail: session.customer_email,
      customerPhone: session.metadata.customerPhone,
      shippingAddress: session.metadata.shippingAddress,
      notes: session.metadata.notes,
      amount: session.amount_total,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.data.orders.push(order);
    await db.write();

    // Send confirmation email
    await sendOrderConfirmation(order);
    
    // Send internal notification
    await sendInternalNotification(order);
  }

  res.json({ received: true });
});

// Get order details
app.get('/api/order/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const order = db.data.orders.find(o => o.stripeSessionId === req.params.sessionId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      order,
      session: {
        paymentStatus: session.payment_status,
        customerEmail: session.customer_email
      }
    });
  } catch (error) {
    console.error('Order fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Admin: Get all orders
app.get('/api/admin/orders', async (req, res) => {
  try {
    // In production, add authentication middleware
    const orders = db.data.orders.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ orders });
  } catch (error) {
    console.error('Orders fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Admin: Update order status
app.patch('/api/admin/orders/:orderId', async (req, res) => {
  try {
    const { status } = req.body;
    const order = db.data.orders.find(o => o.id === req.params.orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    order.status = status;
    order.updatedAt = new Date().toISOString();
    await db.write();

    // Send status update email
    await sendStatusUpdate(order);

    res.json({ success: true, order });
  } catch (error) {
    console.error('Order update error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Email functions
async function sendOrderConfirmation(order) {
  const vibeName = VIBES[order.vibe];
  const productName = PRODUCTS[order.tier].name;

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: order.customerEmail,
    subject: `Order Confirmation - Jay's Frames Holiday Poster`,
    html: `
      <h2>Thank you for your order, ${order.customerName}!</h2>
      <p>Your custom holiday movie poster order has been received.</p>
      
      <h3>Order Details:</h3>
      <ul>
        <li><strong>Movie Vibe:</strong> ${vibeName}</li>
        <li><strong>Product:</strong> ${productName}</li>
        <li><strong>Quantity:</strong> ${order.quantity}</li>
        <li><strong>Order ID:</strong> ${order.id}</li>
        <li><strong>Total:</strong> $${(order.amount / 100).toFixed(2)}</li>
      </ul>
      
      <p><strong>What's Next?</strong></p>
      <p>Our team will create your custom poster and send you a proof for approval within 3-5 business days. You'll receive an email with the preview.</p>
      
      ${order.notes ? `<p><strong>Your Notes:</strong> ${order.notes}</p>` : ''}
      
      <p>Questions? Reply to this email or call us at (555) 123-4567.</p>
      
      <p>Thank you,<br>The Jay's Frames Team</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Email error:', error);
  }
}

async function sendInternalNotification(order) {
  const vibeName = VIBES[order.vibe];
  const productName = PRODUCTS[order.tier].name;

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: `New Order: ${order.id}`,
    html: `
      <h2>New Holiday Poster Order</h2>
      
      <h3>Customer:</h3>
      <ul>
        <li><strong>Name:</strong> ${order.customerName}</li>
        <li><strong>Email:</strong> ${order.customerEmail}</li>
        <li><strong>Phone:</strong> ${order.customerPhone || 'N/A'}</li>
      </ul>
      
      <h3>Order Details:</h3>
      <ul>
        <li><strong>Order ID:</strong> ${order.id}</li>
        <li><strong>Movie Vibe:</strong> ${vibeName}</li>
        <li><strong>Product:</strong> ${productName}</li>
        <li><strong>Quantity:</strong> ${order.quantity}</li>
        <li><strong>Total:</strong> $${(order.amount / 100).toFixed(2)}</li>
      </ul>
      
      <p><strong>Photo Upload ID:</strong> ${order.uploadId}</p>
      <p><strong>Photo URL:</strong> ${process.env.BASE_URL}/uploads/${order.uploadId}</p>
      
      ${order.shippingAddress ? `<p><strong>Shipping Address:</strong><br>${order.shippingAddress}</p>` : ''}
      ${order.notes ? `<p><strong>Customer Notes:</strong><br>${order.notes}</p>` : ''}
      
      <p><a href="${process.env.BASE_URL}/admin">View in Admin Panel</a></p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Internal email error:', error);
  }
}

async function sendStatusUpdate(order) {
  const statusMessages = {
    pending: 'Your order is being processed.',
    designing: 'Our team is creating your custom poster!',
    proof_ready: 'Your proof is ready for review! Check your email for the preview.',
    approved: 'Your design has been approved and is being prepared.',
    printing: 'Your poster is being printed on museum-quality paper.',
    shipped: 'Your order has shipped! Check your email for tracking info.',
    completed: 'Your order is complete! We hope you love it.'
  };

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: order.customerEmail,
    subject: `Order Update - Jay's Frames (Order #${order.id.substring(0, 8)})`,
    html: `
      <h2>Order Status Update</h2>
      <p>Hello ${order.customerName},</p>
      
      <p><strong>Status:</strong> ${order.status.toUpperCase()}</p>
      <p>${statusMessages[order.status]}</p>
      
      <p><strong>Order ID:</strong> ${order.id}</p>
      
      <p>Questions? Reply to this email.</p>
      
      <p>Best,<br>The Jay's Frames Team</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Status email error:', error);
  }
}

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Jay's Frames server running on port ${PORT}`);
});
