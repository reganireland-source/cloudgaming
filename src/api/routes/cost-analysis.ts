/**
 * ============================================================================
 * src/api/routes/cost-analysis.ts — "WHICH CLOUD/REGION SHOULD I USE?"
 * ============================================================================
 *
 * Powers the cost comparison table (frontend/components/CostAnalysisComparison.tsx):
 * given how you play (machine size, quality, hours per month), what would it
 * cost on each cloud and region, and which is the best deal?
 *
 * Mounted at /api/cost-analysis (login required):
 *   POST /api/cost-analysis/compare                     compare every region
 *   GET  /api/cost-analysis/estimate                    one configuration's monthly cost
 *   POST /api/cost-analysis/commitment-savings          savings from 1- or 3-year commitments
 *   GET  /api/cost-analysis/performance/:instanceType   latency/uptime figures for a region
 *
 * IMPORTANT: the prices and performance figures come from a hard-coded
 * table inside src/services/CostAnalysisService.ts — estimates, not live
 * prices fetched from the cloud providers.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { CostAnalysisService } from '../../services/CostAnalysisService';

const router = Router();

/**
 * POST /api/cost-analysis/compare
 * Body (every field optional, defaults shown):
 *   { instanceType: 'g4dn.xlarge', quality: 'good', usageHoursPerMonth: 100,
 *     snapshotSizeGb: 100, providers: ['aws','azure','gcp'] }
 * Returns every matching region with its cost breakdown, plus recommended /
 * cheapest / fastest picks.
 */
router.post('/compare', async (req: Request, res: Response) => {
  try {
    // Destructuring with defaults: if a field is missing from the body,
    // the value after `=` is used instead.
    const {
      instanceType = 'g4dn.xlarge',
      quality = 'good',
      usageHoursPerMonth = 100,
      snapshotSizeGb = 100,
      providers = ['aws', 'azure', 'gcp'],
    } = req.body;

    // No `await`: analyzeCosts is a plain calculation that returns
    // immediately (no database or network involved).
    const analysis = CostAnalysisService.analyzeCosts({
      instanceType,
      quality,
      usageHoursPerMonth,
      snapshotSizeGb,
      providers,
    });

    res.json(analysis);
  } catch (error: any) {
    console.error('Cost analysis error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze costs' });
  }
});

/**
 * GET /api/cost-analysis/estimate?provider=aws&region=ap-southeast-1&instanceType=g4dn.xlarge&quality=good&hoursPerWeek=10
 * Monthly cost for ONE specific setup, split into compute / egress / snapshot.
 */
router.get('/estimate', async (req: Request, res: Response) => {
  try {
    const {
      provider = 'aws',
      region = 'ap-southeast-1',
      instanceType = 'g4dn.xlarge',
      quality = 'good',
      hoursPerWeek = 10,
    } = req.query;

    // Query-string values are text (or arrays of text), so each is cast to
    // string, and the number is parsed.
    const estimate = CostAnalysisService.estimateMachineMonthly({
      provider: provider as string,
      region: region as string,
      instanceType: instanceType as string,
      quality: quality as string,
      hoursPerWeek: parseInt(hoursPerWeek as string) || 10,
    });

    res.json(estimate);
  } catch (error: any) {
    console.error('Cost estimate error:', error);
    res.status(500).json({ error: error.message || 'Failed to estimate cost' });
  }
});

/**
 * POST /api/cost-analysis/commitment-savings
 * Clouds give discounts if you promise to pay for 1 or 3 years up front.
 * Body: { "baseMonthlyCost": 90, "commitmentMonths": 12 }
 */
router.post('/commitment-savings', async (req: Request, res: Response) => {
  try {
    const { baseMonthlyCost, commitmentMonths = 12 } = req.body;

    if (!baseMonthlyCost || baseMonthlyCost <= 0) {
      return res.status(400).json({ error: 'Valid baseMonthlyCost is required' });
    }

    const savings = CostAnalysisService.calculateSavings(baseMonthlyCost, commitmentMonths);
    res.json(savings);
  } catch (error: any) {
    console.error('Savings calculation error:', error);
    res.status(500).json({ error: error.message || 'Failed to calculate savings' });
  }
});

/**
 * GET /api/cost-analysis/performance/:instanceType?provider=aws&region=ap-southeast-1
 * Estimated latency / availability / throughput for a machine type in a region.
 * (The older comment path "/performance/:provider/:region/:instanceType" was
 * inaccurate — provider and region are ?query values, not path segments.)
 */
router.get(
  '/performance/:instanceType',
  async (req: Request, res: Response) => {
    try {
      const {
        instanceType,
      } = req.params;
      const {
        provider = 'aws',
        region = 'ap-southeast-1',
      } = req.query;

      const metrics = CostAnalysisService.getPerformanceMetrics(
        instanceType,
        provider as string,
        region as string
      );

      // The service returns null when it has no figures for that combination.
      if (!metrics) {
        return res.status(404).json({ error: 'Performance metrics not found' });
      }

      res.json(metrics);
    } catch (error: any) {
      console.error('Performance metrics error:', error);
      res.status(500).json({ error: error.message || 'Failed to get performance metrics' });
    }
  }
);

export default router;
