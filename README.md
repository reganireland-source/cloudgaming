# CloudGaming Hub

A multi-cloud gaming infrastructure platform that enables cost-optimized game streaming across AWS, Azure, GCP, and Oracle Cloud. Find the best cloud region for your game, location, and budget with automated cost tracking and real-time bill of materials visualization.

## Features

### 🎮 Game-Aware Recommendations
- Search for your game (e.g., "Elden Ring", "Baldur's Gate 3")
- Get recommendations based on your location (latitude/longitude)
- Filter by budget per hour
- Algorithm recommends best provider, region, instance type, and streaming quality
- Haversine formula calculates real latency from your location to cloud regions

### 💰 Cost Optimization
- **Real-time Bill of Materials**: Stylized technical diagram showing compute + streaming egress + storage costs
- **Cost Breakdown**: See exactly what you're paying for (instance type, quality tier, egress rate)
- **Multi-provider Support**: AWS, Azure, GCP, Oracle with unified cost tracking
- **Oracle Advantage**: Free egress changes the economics dramatically for Singapore region
- **Streaming Quality Tiers**: Budget, Good, High, Ultra with GB/hr and cost calculations

### 🌍 Multi-Cloud Infrastructure
- **Unified API**: Single interface for AWS, Azure, GCP, Oracle
- **Machine Migration**: Snapshot in one cloud, restore in another
- **Real-time Pricing**: Dynamic pricing from provider APIs
- **Regional Awareness**: Latency-based recommendations
- **Auto-shutdown**: Idle machines terminate after 15 minutes

### 📊 Cost Tracking & Forecasting
- Daily spending trends with 30-day history
- Monthly cost breakdown by provider
- Forecast end-of-month spend based on daily average
- Budget caps with alert thresholds
- Per-machine cost calculation

### 🖥️ Performance Portal (More Accessible Than Traditional Cloud Platforms)
- **Real-Time Monitoring**: CPU, GPU, bandwidth, FPS, packet loss, temperatures updated every minute
- **Health Status Indicators**: Healthy/Warning/Critical alerts with specific issues
- **Comprehensive Metrics**:
  - CPU & GPU usage (%) with thermal monitoring
  - GPU memory and system memory utilization
  - Network bandwidth (upload/download) and latency
  - Streaming frame rate (FPS) and frame drops
  - Disk I/O performance (IOPS and throughput)
  - Network packet loss and connection quality
- **Performance Charts**: 
  - Area charts for CPU/GPU usage trends
  - Streaming quality indicators (FPS vs packet loss)
  - Disk I/O performance visualization
  - Network bandwidth trends
- **Statistics Dashboard**: Current, average, and peak metrics for 1-hour window
- **Health Checks**: Automatic detection of thermal throttling, high packet loss, low FPS
- **Performance Tips**: Best practice guidance for each metric

## Architecture

```
cloudgaming/
├── src/                          # Node.js/Express backend (TypeScript)
│   ├── api/
│   │   ├── routes/              # API endpoints
│   │   │   ├── auth.ts          # User registration/login
│   │   │   ├── machines.ts      # Machine lifecycle
│   │   │   ├── costs.ts         # Cost aggregation
│   │   │   ├── regions.ts       # Region recommendations
│   │   │   └── performance.ts   # Real-time performance metrics
│   │   └── middleware/
│   │       └── auth.ts          # JWT authentication
│   ├── providers/               # Cloud provider abstraction
│   │   ├── Provider.ts          # Base interface
│   │   ├── AWSProvider.ts       # AWS implementation (full)
│   │   ├── AzureProvider.ts     # Azure implementation
│   │   ├── GCPProvider.ts       # GCP implementation
│   │   └── OracleProvider.ts    # Oracle implementation
│   ├── services/                # Business logic
│   │   ├── CostService.ts       # Cost aggregation & forecasting
│   │   ├── RecommendationEngine.ts  # Game-aware recommendations
│   │   ├── PerformanceService.ts # Real-time performance metrics & health status
│   │   └── MachineService.ts    # Machine orchestration
│   ├── jobs/                    # Background jobs
│   │   ├── SyncCosts.ts         # Hourly cost sync, idle shutdown, budget alerts
│   │   ├── CollectPerformance.ts # Minute-level performance metric collection
│   │   └── index.ts             # Job scheduling (node-cron)
│   ├── config/
│   │   ├── env.ts               # Environment validation
│   │   └── database.ts          # PostgreSQL connection pool
│   ├── db/
│   │   └── schema.sql           # Database schema with seed data
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces
│   └── index.ts                 # Express server entry point
│
└── frontend/                     # Next.js 14 frontend (React + TypeScript)
    ├── app/
    │   ├── layout.tsx           # Main layout with navigation
    │   ├── page.tsx             # Dashboard with BoM visualization
    │   ├── machines/
    │   │   └── page.tsx         # Machine management
    │   ├── performance/
    │   │   └── page.tsx         # Real-time performance monitoring portal
    │   ├── recommendations/
    │   │   └── page.tsx         # Game recommendation search
    │   ├── costs/
    │   │   └── page.tsx         # Cost tracking & forecasting
    │   └── globals.css          # Tailwind styles
    ├── components/
    │   ├── BillOfMaterials.tsx  # Cost diagram component
    │   └── PerformanceStats.tsx # Performance charts and metrics
    ├── tailwind.config.js       # Tailwind configuration
    └── next.config.js           # Next.js configuration
```

## Database Schema

### Core Tables
- **users**: User accounts with budget settings
- **cloud_credentials**: Encrypted per-provider credentials (per user)
- **machines**: Running gaming instances with provider/region/status
- **snapshots**: Machine images for cross-cloud migration
- **costs**: Hourly cost records (partitioned by date)
- **performance_metrics**: Real-time performance data (CPU, GPU, bandwidth, FPS, temps) per machine per minute

### Reference Data
- **game_profiles**: Library with GPU class, target quality, VRAM (Valorant, Elden Ring, Baldur's Gate 3, Minecraft)
- **streaming_qualities**: Quality tiers with resolution, fps, bitrate, GB/hr, cost
- **region_data**: Pricing and egress costs per provider/region

## Backend API

### Authentication
```
POST /api/auth/register         # Create new user
POST /api/auth/login            # Get JWT token
POST /api/auth/cloud-credentials # Store encrypted provider credentials
GET  /api/auth/me               # Get current user
```

### Machines
```
GET  /api/machines              # List user's machines
GET  /api/machines/:id          # Get machine details
POST /api/machines              # Launch new machine
POST /api/machines/:id/start    # Start stopped machine
POST /api/machines/:id/stop     # Stop running machine (snapshot optional)
POST /api/machines/:id/migrate  # Migrate to another provider/region
DELETE /api/machines/:id        # Delete machine
```

### Costs
```
GET  /api/costs/monthly         # Monthly breakdown by provider
GET  /api/costs/daily           # Last 30 days daily history
GET  /api/costs/forecast        # Month-end projection
POST /api/costs/budget          # Set budget cap & alert threshold
```

### Regions & Recommendations
```
GET  /api/regions               # List all regions with pricing
POST /api/regions/test-latency  # Calculate latency to region
GET  /api/regions/recommend     # Get game recommendations (game, lat, lng, budget)
GET  /api/regions/qualities     # Streaming quality tiers for a region
```

### Performance Monitoring
```
GET  /api/performance/:machineId           # Get performance stats (CPU, GPU, network, FPS, temps)
GET  /api/performance/:machineId/realtime  # Get latest performance metric
GET  /api/performance/:machineId/health    # Get machine health status (healthy/warning/critical)
```

## Bill of Materials Visualization

The frontend's centerpiece is the **Bill of Materials** component, a stylized technical diagram showing:

1. **Compute Component**: Instance type, quantity, cost per unit, total hourly cost
2. **Streaming Component**: Resolution, FPS, bitrate, GB/hr, egress rate, cost per hour
3. **Total Cost**: Aggregated hourly/daily/monthly pricing
4. **Cost Distribution Pie Chart**: Visual breakdown of compute vs egress costs
5. **Forecast Summary**: Monthly cost if running continuously, percentage breakdown

Example for g4dn.xlarge in AWS us-east-1:
- Compute: $0.526/hr
- Streaming (1440p 60fps): $0.432/hr (egress)
- **Total: $0.958/hr = $22.99/day = $689.76/month**

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Cloud provider accounts (AWS, Azure, GCP, Oracle)

### Backend Setup

```bash
cd src

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your DATABASE_URL, JWT_SECRET, etc.

# Initialize database
npm run migrate

# Development server (runs on port 3001)
npm run dev

# Build for production
npm run build
npm start
```

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Set environment variables
cp .env.example .env.local
# Edit .env.local with NEXT_PUBLIC_API_URL

# Development server (runs on port 3000)
npm run dev

# Build for production
npm run build
npm start
```

## MVP Notes

### Mocked Features (for development without cloud credentials)
- Cost sync job uses `Math.random()` for demo costs instead of real provider APIs
- Cloud provider credential validation passes dummy data
- No actual instances are launched without real AWS/Azure/GCP/Oracle credentials

### Ready for Production
- Database schema with all necessary tables
- JWT authentication with encrypted credential storage
- Cost forecasting algorithm
- Game-aware recommendation engine with Haversine latency
- Bill of materials calculation and visualization
- Background job orchestration

## Deployment

### Backend (Node.js on Railway/Heroku)
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
```

### Frontend (Next.js on Vercel)
```
NEXT_PUBLIC_API_URL=https://your-api.railway.app/api
```

## Future Enhancements

- [ ] Actual cloud provider API integration (AWS Pricing, Cost Explorer, etc.)
- [ ] Email notifications for budget alerts
- [ ] Kubernetes-style workload migration
- [ ] Game performance benchmarking per instance type
- [ ] Custom streaming profiles per game
- [ ] Multi-user team management
- [ ] Mobile app with native OS controls
- [ ] Spot instance support with interruption handling

## Economic Model

### Why DIY Cloud Gaming Works
1. **Oracle Free Egress**: No data transfer costs in Singapore region (changes the math)
2. **Spot Instances**: 30% of on-demand pricing for idle machines
3. **Region Optimization**: Latency-aware selection minimizes streaming quality costs
4. **Idle Auto-shutdown**: 15-minute inactivity threshold prevents runaway costs

### Competitive Analysis
- **Shadow/airGPU**: $30-35/month, always on, limited regions
- **DIY with this platform**: $20-25/month for similar performance in Singapore, + cheaper elsewhere with Oracle free egress

## Technology Stack

**Backend**: Node.js 18+, Express, TypeScript, PostgreSQL, node-cron  
**Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, Recharts  
**Cloud SDKs**: AWS SDK, Azure SDK, Google Cloud, Oracle OCI SDK  
**Security**: JWT, bcrypt, helmet, CORS  

## License

MIT
