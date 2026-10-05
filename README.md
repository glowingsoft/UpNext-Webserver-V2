# MERN UpNext Project
The **MERN UpNext** is a starter template for building full-stack web applications using MongoDB, Express.js, React, and Node.js. This project provides a scalable and organized codebase that you can quickly adapt for various applications such as social apps, e-commerce platforms, or any custom projects.

## Table of Contents

- [MERN UpNext Project](#mern-upnext-project)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Installation](#installation)
  - [JWT creation](#jwt-creation)
  - [ENVIRONMENTS SETUP](#environments-setup)
    - [Prerequisites](#prerequisites)
    - [Steps](#steps)
  - [Technologies Used](#technologies-used)
  - [Project Structure](#project-structure)
  - [Postman Collection](#postman-collection)
  - [License](#license)
  - [Contact](#contact)

## Features

- JWT-based Authentication (login, register, password reset)
- Social Logins (Google, Facebook, Apple)
- RESTful API with CRUD functionality
- Secure API endpoints using role-based authentication
- Rate Limiting for certain endpoints
- Modular and scalable code structure
- Environment-based configuration

## Installation
- npm i
- create .env.dev file from .env.example provided in root folder
- set NODE_ENV=dev in .env.dev file

## JWT creation
- use goto project folder and run  "node ./helperUtils/jwtSecret.js"
- copy JWT_SECRET and ADMIN_ACCESS_TOKEN values from terminal and paste in .env.dev file
- use "npm run dev" to run the app with dev environment

## ENVIRONMENTS SETUP
- refer to packages.json file for dev, qa, prod environments for create another as needed
- create values and add in desired .env file

### Prerequisites

Ensure you have the following installed:

- [Node.js](https://nodejs.org/) >= v14.x
- [MongoDB](https://www.mongodb.com/) (Running as a replica set for transactions)
- [NPM](https://www.npmjs.com/) or [Yarn](https://yarnpkg.com/)

### Steps

1. Clone the repository:

    ```bash
    git clone https://github.com/cwaliimran/Mern-UpNext.git
    ```

2. Update locales in "assets/locales" 

3. DOWNLOAD FILE FROM Firebase -> Project settings/Service accounts/Generate new private key

5. Add the contents of downloaded key in serviceAccountKey.json

## Technologies Used

- MongoDB
- Express.js
- React
- Node.js

## Project Structure

- `src/` - Contains the source code
- `config/` - Configuration files
- `models/` - Database models
- `routes/` - API routes
- `controllers/` - Request handlers
- `middlewares/` - Custom middleware functions

## Postman Collection

- `postman_collection/` - Postman collection

## License

This project is licensed under the MIT License.

## Contact

For any inquiries, please contact [cwaliimran@gmail.com].
