import dotenv from 'dotenv';

dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',

  // Cloud providers
  AWS_REGION: process.env.AWS_REGION || 'ap-southeast-1',
  AZURE_SUBSCRIPTION_ID: process.env.AZURE_SUBSCRIPTION_ID || '',
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || '',

  // Mail
  MAIL_SERVICE: process.env.MAIL_SERVICE || 'smtp',
  MAIL_FROM: process.env.MAIL_FROM || 'noreply@cloudgaming.dev',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// Validate required env vars
const requiredEnvs = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of requiredEnvs) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
