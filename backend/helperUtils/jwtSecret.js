const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// colors
const yellow = '\x1b[33m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

// Function to generate a secure JWT secret
function generateJWTSecret(length = 64) {
  return crypto.randomBytes(length).toString('hex');
}

// Generate the secret
const jwtSecret = generateJWTSecret(64);

console.log(`${yellow}Your JWT_SECRET for .env value JWT_SECRET:${reset} ${green}${jwtSecret}${reset}`);

const secretKey = jwtSecret;

const payload = { role: 'admin-creation' };
const options = { expiresIn: '1h' };

const adminCreationToken = jwt.sign(payload, secretKey, options);

console.log(`${yellow}Generated Token For .env value ADMIN_ACCESS_TOKEN:${reset} ${cyan}${adminCreationToken}${reset}`);
