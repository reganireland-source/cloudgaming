# Gints Global Gaming Hubjob Frontend

Next.js frontend for the multi-cloud gaming infrastructure platform.

## Features

- **Dashboard**: Monitor active machines and their real-time costs
- **Bill of Materials**: Stylized cost breakdown diagram showing compute, streaming, and storage costs
- **Machine Management**: Start, stop, and delete cloud gaming instances
- **Game Recommendations**: Find the best cloud region based on game, location, and budget
- **Cost Tracking**: Daily spending trends, provider breakdown, and monthly projections
- **Responsive Design**: Works on desktop, tablet, and mobile

## Tech Stack

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Recharts (for visualizations)
- Axios

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:3000
```

## Environment Variables

Create a `.env.local` file:

```
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

## Pages

- `/` - Dashboard with current machine status and bill of materials
- `/machines` - List of machines with start/stop/delete controls
- `/recommendations` - Game recommendation engine
- `/costs` - Cost tracking and budget settings

## Components

### BillOfMaterials

The main component for visualizing costs in a technical diagram format:
- Shows compute, streaming, and storage costs
- Displays cost per hour/day/month
- Pie chart showing cost distribution
- Technical specifications of the machine

## Building for Production

```bash
npm run build
npm start
```
