import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { query as dbQuery } from './config/database';
import { initializeJobs } from './jobs';

// Import routes
import authRoutes from './api/routes/auth';
import machineRoutes from './api/routes/machines';
import costRoutes from './api/routes/costs';
import regionRoutes from './api/routes/regions';
import performanceRoutes from './api/routes/performance';
import streamingRoutes from './api/routes/streaming';

// Middleware
import { authMiddleware } from './api/middleware/auth';

const app: Express = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    await dbQuery('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'database-error', error });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/machines', authMiddleware, machineRoutes);
app.use('/api/costs', authMiddleware, costRoutes);
app.use('/api/regions', authMiddleware, regionRoutes);
app.use('/api/performance', authMiddleware, performanceRoutes);
app.use('/api/streaming', streamingRoutes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
    code: err.code,
  });
});

// Start server
const PORT = env.PORT;

// Initialize background jobs
initializeJobs();

app.listen(PORT, () => {
  console.log(`CloudGaming Hub backend running on port ${PORT}`);
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`Log level: ${env.LOG_LEVEL}`);
});

export default app;
