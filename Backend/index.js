require("core-js/stable");
require("regenerator-runtime/runtime");

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const AWS = require('aws-sdk');
const moment = require('moment');
require('dotenv').config();
const app = express();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const port = 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Construct the path to the frontend build directory
const frontendBuildPath = path.resolve(__dirname, '..', 'Frontend', 'cloud-proj', 'build');

// Serve frontend build files
app.use(express.static(frontendBuildPath));


// Set the AWS region
// AWS.config.update({ region: 'us-east-1' }); // Replace 'your_region' with your desired region
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1',
  sessionToken: process.env.AWS_SESSION_TOKEN,
});


// Create an AWS Secrets Manager client
const secretsManager = new AWS.SecretsManager();

// Function to retrieve secret value from Secrets Manager
const getSecretValue = async (secretName) => {
  try {
    const data = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    if ('SecretString' in data) {
      return data.SecretString;
    } else {
      const buff = new Buffer(data.SecretBinary, 'base64');
      return buff.toString('ascii');
    }
  } catch (error) {
    console.error('Error retrieving secret:', error);
    throw error;
  }
};

// Function to create required tables if they don't exist
const createTablesIfNotExist = async (pool) => {
  try {
    // Check if the 'users' table exists, create if not
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);

    // Check if the 'todos' table exists, create if not
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        deadline TIMESTAMP,
        is_open BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by INT,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  }
}


// Database connection string secret name
const dbSecretName = 'connectionStringForPG2'; // Replace with your PostgreSQL secret name



// Create a pool using the retrieved connection string
const createPool = async () => {
  try {
    const dbSecretString = await getSecretValue(dbSecretName);
    const dbSecret = JSON.parse(dbSecretString);
    const pool = new Pool({
      connectionString: dbSecret.connectionStringForPG2,
      // connectionString: `postgres://postgres:postgres@localhost:5432/todos`,
      ssl: {
        rejectUnauthorized: false
      }
    });
    // Check if required tables exist, create if not
    await createTablesIfNotExist(pool);

    return pool;
  } catch (error) {
    console.error('Error creating pool:', error);
    throw error;
  }
};

// Catch-all route to serve the frontend HTML file
app.get('/*', (req, res) => {
  // Read the HTML file and send it as response
  const html = fs.readFileSync(path.resolve(__dirname, '../', 'Frontend','cloud-proj', 'build', 'index.html'), 'utf8');
  res.send(html);
});

// User Signup API
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;

  // Hash the password before storing it
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    // Check if the user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // If user doesn't exist, insert the new user
    const newUser = await pool.query(
      'INSERT INTO users(email, password) VALUES($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );

    // Generate JWT token for the new user
    const token = jwt.sign({ userId: newUser.rows[0].id, userEmail: newUser.rows[0].email }, 'your_secret_key', {
      expiresIn: '24h', // You can adjust the expiration time
    });

    res.json({ userId: newUser.rows[0].id, email: newUser.rows[0].email, token });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

// User Signin API
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Check if the user exists
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare the provided password with the stored hashed password
    const isPasswordValid = await bcrypt.compare(password, user.rows[0].password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // If passwords match, generate JWT token for the user
    const token = jwt.sign({ userId: user.rows[0].id, userEmail: user.rows[0].email }, 'your_secret_key', {
      expiresIn: '24h', 
    });

    res.json({ userId: user.rows[0].id, email: user.rows[0].email, token });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

// API for CRUD operations on Todo List
app.get('/api/todos', async (req, res) => {
  const { userId } = req.query;
  try {
    const todos = await pool.query('SELECT * FROM todos WHERE created_by = $1', [userId]);
    res.json(todos.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/api/todos', async (req, res) => {
  const { title, description, deadline, is_open, created_by } = req.body;
  try {
    const newTodo = await pool.query(
      'INSERT INTO todos(title, description, deadline, is_open, created_at, created_by) VALUES($1, $2, $3, $4, CURRENT_TIMESTAMP, $5) RETURNING *',
      [title, description, deadline, is_open, created_by]
    );
    res.json(newTodo.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

app.put('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  console.log("id like userId",id);
  const { title, description, deadline, is_open, created_by, closed_at } = req.body; 
  try {
    let query;
    let values;
    
    if (closed_at !== undefined) {
      // If closed_at is provided, update both is_open and closed_at fields
      query = 'UPDATE todos SET title = $1, description = $2, deadline = $3, is_open = $4, created_by = $5, closed_at = $6 WHERE id = $7 RETURNING *';
      values = [title, description, deadline, is_open, created_by, closed_at, id];
    } else {
      // If closed_at is not provided, update only other fields
      query = 'UPDATE todos SET title = $1, description = $2, deadline = $3, is_open = $4, created_by = $5 WHERE id = $6 RETURNING *';
      values = [title, description, deadline, is_open, created_by, id];
    }
    
    const updatedTodo = await pool.query(query, values);
    res.json(updatedTodo.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});


app.delete('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM todos WHERE id = $1', [id]);
    res.json({ message: 'Todo deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});


// Create a pool for database operations
let pool;

// Create a pool when the application starts
createPool().then((createdPool) => {
  pool = createdPool;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}).catch((error) => {
  console.error('Error creating pool:', error);
});


