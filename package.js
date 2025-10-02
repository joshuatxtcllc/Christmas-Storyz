// package.json
{
  "name": "jays-frames",
  "version": "1.0.0",
  "type": "module",
  "description": "Custom holiday movie poster ordering system",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "stripe": "^14.5.0",
    "multer": "^1.4.5-lts.1",
    "uuid": "^9.0.1",
    "nodemailer": "^6.9.7",
    "lowdb": "^7.0.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
