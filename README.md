# Wedsy Server

## Introduction

This repository contains the source code for a Node.js Express backend for Wedsy. This backend serves as the server-side logic for your application.

## Prerequisites

Before running the application, make sure you have the following installed:

- [Node.js](https://nodejs.org/) (version 14 or higher)
- [npm](https://www.npmjs.com/) (Node.js package manager)

## Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/nikhilagarwal204/wedsy-server.git
   ```

2. **Navigate to the project directory:**

   ```bash
   cd wedsy-server
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

## Environment Variables

Create a `.env` file in the root of the project and add the following environment variables:

```env
# Set the port for the server (development only)
PORT=8080

# Set the environment (development, production, etc.)
NODE_ENV=development

DATABASE_URL=
JWT_SECRET=

# AWS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_BUCKET_NAME=
AWS_PINPOINT_PROJECT_ID=
AWS_PINPOINT_REGION=
AWS_PINPOINT_ENDPOINT=
AWS_PINPOINT_SENDER_ID=
AWS_S3_REGION=

# Razporpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# FAST2SMS
FAST2SMS_API_URL=
FAST2SMS_API_KEY=

# AISENSY
AISENSY_API_URL=
AISENSY_API_KEY=
```

Make sure to replace the placeholder values with your actual configuration.

## Run

To start the server, use the following command:

```bash
node server.js
```

## Development

For development purposes, you can use the following command to run the server with hot-reloading using nodemon:

```bash
nodemon server.js
```

This will start the server at http://localhost:8080 (or the port specified in your .env file, for development).
