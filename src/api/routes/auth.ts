import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { generateJWT } from '../middleware/auth';

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Create user
    const result = await query(
      'INSERT INTO users (email) VALUES ($1) RETURNING id, email',
      [email]
    );

    const user = result.rows[0];
    const token = generateJWT(user.id, user.email);

    res.json({ userId: user.id, email: user.email, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Login with email (OAuth2-like flow)
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Get user
    const result = await query(
      'SELECT id, email FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const token = generateJWT(user.id, user.email);

    res.json({ userId: user.id, email: user.email, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/cloud-credentials
 * Store encrypted cloud provider credentials (AWS, Azure, GCP, Oracle)
 */
router.post('/cloud-credentials', async (req: Request, res: Response) => {
  try {
    const { provider, encryptedData } = req.body;
    const userId = req.userId;

    if (!userId || !provider || !encryptedData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store encrypted credentials
    const result = await query(
      `INSERT INTO cloud_credentials (user_id, provider, encrypted_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_data = $3
       RETURNING id`,
      [userId, provider, encryptedData]
    );

    res.json({ credentialsId: result.rows[0].id });
  } catch (error) {
    console.error('Cloud credentials error:', error);
    res.status(500).json({ error: 'Failed to store credentials' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await query(
      'SELECT id, email, budget_cap, budget_alert_threshold FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      budgetCap: user.budget_cap,
      budgetAlertThreshold: user.budget_alert_threshold,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
