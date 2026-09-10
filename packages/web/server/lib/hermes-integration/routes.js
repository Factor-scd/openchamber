import express from 'express';

export function registerHermesIntegrationRoutes(app, hermesIntegrationRuntime) {
  app.get('/api/openchamber/hermes/status', async (req, res) => {
    try {
      const status = await hermesIntegrationRuntime.getStatus();
      return res.json(status);
    } catch (error) {
      const statusCode = Number.isFinite(error?.status) ? error.status : 500;
      return res.status(statusCode).json({
        ok: false,
        error: error?.message ?? 'Failed to get Hermes integration status',
      });
    }
  });
}
