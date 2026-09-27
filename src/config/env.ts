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

  // Gaming AMI Configuration
  CLOUDGAMING_AMI_ID: process.env.CLOUDGAMING_AMI_ID || 'ami-0c55b159cbfafe1f0',

  // SSH Configuration for CloudyPad setup
  SSH_KEY_PATH: process.env.SSH_KEY_PATH || '/root/.ssh/cloudgaming-key.pem',
  SSH_USERNAME: process.env.SSH_USERNAME || 'Administrator',
  SSH_TIMEOUT_MS: parseInt(process.env.SSH_TIMEOUT_MS || '300000', 10), // 5 minutes
  SSH_RETRY_DELAY_MS: parseInt(process.env.SSH_RETRY_DELAY_MS || '10000', 10), // 10 seconds

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
