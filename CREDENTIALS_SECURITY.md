# Credential Security & Multi-User Tenancy

## Architecture: Frontend Credential Entry + Backend Encryption Storage

This document outlines how Gints Global Gaming Hubjob securely handles cloud provider credentials in a multi-user environment.

### Data Flow

```
User Browser (Frontend)
    ↓ (HTTPS only - no plaintext over network)
API Endpoint: POST /api/auth/cloud-credentials
    ↓
Backend - Credential Encryption
    ↓ (AES-256 encryption)
Database - cloud_credentials table
    ↓ (Encrypted storage)
Backend - When needed, decrypt and use
```

## Frontend Credential Entry

**Location**: `/settings` page

**Approach**: Users enter their cloud provider credentials directly in the browser UI

### Why Frontend Entry for Multi-User?

1. **Per-User Isolation**: Each user has their own set of cloud accounts
2. **Flexibility**: Users can add/remove providers at any time
3. **No Shared Configuration**: Unlike backend env vars (single set for all users)
4. **User Control**: Users know exactly which credentials are being stored

### Per-Provider Credentials

**AWS**:
- Access Key ID
- Secret Access Key
- Region

**Azure**:
- Subscription ID
- Client ID
- Client Secret
- Tenant ID
- Resource Group

**GCP**:
- Project ID
- Service Account Key (JSON)

**Oracle**:
- Compartment ID
- User ID
- Tenancy OCID
- Fingerprint
- Private Key (PEM)

## Backend Encryption & Storage

### Database Schema

```sql
CREATE TABLE cloud_credentials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  provider VARCHAR(20) NOT NULL,     -- 'aws', 'azure', 'gcp', 'oracle'
  encrypted_data TEXT NOT NULL,      -- AES-256 encrypted JSON blob
  created_at TIMESTAMP,
  UNIQUE(user_id, provider)
);
```

**Key Design Decisions**:
- One row per user per provider (can only have 1 AWS account, 1 Azure account, etc.)
- Entire credential object encrypted as a single blob
- No plaintext credentials stored anywhere

### Encryption Implementation

```typescript
// Backend encryption (Node.js crypto)
import crypto from 'crypto';

interface EncryptedCredential {
  iv: string;           // Initialization vector (base64)
  encrypted: string;    // Encrypted data (base64)
  algorithm: 'aes-256-gcm';
}

// Encryption
const encryptCredentials = (credentials: object, encryptionKey: string): EncryptedCredential => {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(encryptionKey, 'salt', 32); // Derive key from secret
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('base64'),
    encrypted: Buffer.concat([Buffer.from(encrypted, 'hex'), authTag]).toString('base64'),
    algorithm: 'aes-256-gcm'
  };
};

// Decryption
const decryptCredentials = (encrypted: EncryptedCredential, encryptionKey: string): object => {
  const key = crypto.scryptSync(encryptionKey, 'salt', 32);
  const iv = Buffer.from(encrypted.iv, 'base64');
  const data = Buffer.from(encrypted.encrypted, 'base64');
  
  const authTag = data.slice(-16);
  const ciphertext = data.slice(0, -16);
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return JSON.parse(decrypted.toString('utf8'));
};
```

### Encryption Key Management

**Secure approach**:
```bash
# Environment variable (never committed)
CREDENTIALS_ENCRYPTION_KEY=<long-random-string-generated-once>
```

**In production, use HSM or AWS KMS**:
```typescript
// Use AWS Secrets Manager or Azure Key Vault for key storage
// Never rotate keys without re-encrypting all stored credentials
```

## API Endpoints

### Store Credentials

```
POST /api/auth/cloud-credentials

Request:
{
  "provider": "aws",
  "credentials": {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "wJal...",
    "region": "us-east-1"
  }
}

Response:
{
  "success": true,
  "message": "AWS credentials saved securely",
  "provider": "aws",
  "validated": true
}
```

**Backend Implementation**:
1. Validate credential format (schema validation with Joi)
2. Test credentials by making API call to cloud provider
3. If valid, encrypt credentials
4. Store in database with user_id
5. Return success/failure

### Retrieve & Use Credentials

```
GET /api/machines (internally uses user's credentials)

Backend Flow:
1. Get user_id from JWT token
2. Query cloud_credentials where user_id AND provider='aws'
3. Decrypt encrypted_data
4. Use decrypted credentials to call AWS API
5. Return results to frontend
```

### Delete Credentials

```
DELETE /api/auth/cloud-credentials/:provider

Backend:
1. Delete row from cloud_credentials table
2. User loses ability to use that cloud provider
3. No cleanup of running instances (user must stop manually first)
```

## Security Considerations

### What's Encrypted
✅ All cloud provider credentials (access keys, secrets, tokens)
✅ Stored in `encrypted_data` column
✅ User's sensitive data at rest

### What's NOT Encrypted (but still private)
- User email (searchable for login)
- Budget settings (user's own data)
- Machine configurations (generated by this app)

### Network Security

**Transit Security**:
```
1. All API calls use HTTPS only (encrypted)
2. Frontend never displays credentials after saving
3. Backend never logs credential values
4. Credentials never appear in URL/query params
```

**Storage Security**:
```
1. Database credentials use connection string with SSL/TLS
2. Encrypted credentials blob stored with AES-256-GCM
3. Authentication tag prevents tampering
4. Each credential has unique IV (initialization vector)
```

### Access Control

```
Frontend:
- User can enter/update/delete their own credentials only
- Validated via JWT token (user_id)

Backend:
- `/api/auth/cloud-credentials` requires valid JWT
- Can only access credentials for authenticated user
- Row-level security: WHERE user_id = req.userId
```

## Threat Model & Mitigations

| Threat | Impact | Mitigation |
|--------|--------|-----------|
| **Credentials exposed in logs** | User's cloud account compromised | Never log credential values; log only provider/success |
| **Database breach** | All credentials stolen | Encryption renders them useless without key; separate key storage |
| **Key compromise** | All credentials decrypted | Rotate encryption key, re-encrypt all credentials |
| **Man-in-the-middle attack** | Credentials intercepted on network | HTTPS/TLS for all connections |
| **Frontend credential logging** | Credentials exposed in browser console | Never store in localStorage/sessionStorage; use encrypted database only |
| **User shares credentials** | No technical control | User education; terms of service |

## Testing Credentials Before Storage

When user saves credentials, backend validates:

```typescript
// AWS example
const validateAWSCredentials = async (creds: AWSCredentials) => {
  const ec2 = new AWS.EC2({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region
  });
  
  try {
    await ec2.describeInstances().promise();
    return { valid: true, message: 'AWS credentials validated' };
  } catch (error) {
    return { valid: false, message: 'Invalid AWS credentials' };
  }
};
```

**Why validate?**
- Catches typos before encryption
- Verifies permissions (read-only on EC2/compute)
- Prevents storing non-functional credentials
- Gives user immediate feedback

## Credential Lifecycle

### 1. Entry
```
User enters credentials in Settings → Frontend
```

### 2. Transmission
```
Frontend → HTTPS POST → Backend
```

### 3. Validation
```
Backend tests API access with provided credentials
If fails: return error, don't store
```

### 4. Storage
```
Backend encrypts credentials blob
Stores in cloud_credentials table
Returns success
```

### 5. Usage
```
When launching machine/syncing costs:
1. Backend queries cloud_credentials for user + provider
2. Decrypts encrypted_data
3. Uses decrypted credentials for API calls
4. Never persists decrypted credentials
```

### 6. Deletion
```
User clicks "Remove" in Settings
Backend deletes cloud_credentials row
Credentials permanently removed
```

## Multi-User Isolation Example

**User A's AWS Account**:
```
user_id: uuid-123
provider: 'aws'
encrypted_data: 'eyJ....' (encrypted)
```

**User B's AWS Account** (different person, different creds):
```
user_id: uuid-456
provider: 'aws'
encrypted_data: 'aaa....' (encrypted, different key)
```

**Backend Guarantee**:
```typescript
// User A can NEVER access User B's credentials
const userCreds = await query(
  `SELECT encrypted_data FROM cloud_credentials 
   WHERE user_id = $1 AND provider = $2`,
  [req.userId, 'aws']  // Can only query by own user_id
);
```

## Compliance & Standards

- **GDPR**: User can request/delete their credentials anytime
- **SOC 2**: Audit logging of credential access (log queries but not values)
- **PCI DSS**: Encryption at rest + in transit (if storing payment data)
- **ISO 27001**: Access controls + encryption + key management

## Recommended Production Setup

```bash
# Environment Setup
export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
export CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)  # 256-bit random
export JWT_SECRET=$(openssl rand -base64 32)

# Storage: AWS KMS for encryption key
# - Encrypt CREDENTIALS_ENCRYPTION_KEY with AWS KMS
# - Rotate key every 90 days
# - Audit all key access

# Database: Encrypted connection
# - Use SSL/TLS certificates
# - Enable at-rest encryption (RDS encryption)
# - Enable audit logging for cloud_credentials table

# Monitoring
# - Alert on multiple failed credential validations (brute force)
# - Alert on credential deletion
# - Log all /api/auth/cloud-credentials API calls (without values)
```

## User Education

In `/settings` page:

✅ Show encryption status visually
✅ Explain what data is stored
✅ Warn about secret key protection
✅ Provide safe credential generation instructions
✅ Show "Last validated" timestamp
✅ Allow credential rotation without deleting

Example UI message:
```
🔒 ENCRYPTED WITH AES-256
Your credentials are encrypted and cannot be read by us or 
anyone else. They're only decrypted when needed to access 
your cloud resources.

Last validated: 2 hours ago
Next auto-validation: Tomorrow at 9 AM
```

## Summary

| Aspect | Implementation |
|--------|----------------|
| **Entry Point** | Frontend settings page (per-user UI) |
| **Transmission** | HTTPS only |
| **Validation** | Test API access before storing |
| **Encryption** | AES-256-GCM at rest in database |
| **Key Storage** | Environment variable (or HSM/KMS in production) |
| **Per-User** | Isolated via user_id + row-level security |
| **Decryption** | Only when needed, never persisted |
| **Audit Trail** | Log API calls (not values) |
| **Deletion** | User-initiated via settings UI |
