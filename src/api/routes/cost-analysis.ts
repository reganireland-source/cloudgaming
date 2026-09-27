import { Router, Request, Response } from 'express';
import { CostAnalysisService } from '../../services/CostAnalysisService';

const router = Router();

/**
 * POST /api/cost-analysis/compare
 * Compare costs and performance across regions/providers
 */
router.post('/compare', async (req: Request, res: Response) => {
  try {
    const {
      instanceType = 'g4dn.xlarge',
      quality = 'good',
      usageHoursPerMonth = 100,
      snapshotSizeGb = 100,
      providers = ['aws', 'azure', 'gcp'],
    } = req.body;

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
 * GET /api/cost-analysis/estimate
 * Estimate monthly cost for a specific configuration
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
 * Calculate savings with multi-year commitments
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
 * GET /api/cost-analysis/performance/:provider/:region/:instanceType
 * Get performance metrics for a specific configuration
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
