import express, { Express } from 'express';
import { registerRoutes } from './routes.js';
import { getBedrockAgentCoreClient, invokeAgentCore, extractAgentReplyText } from './bedrockAgentCore.js';

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(`[server] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });

  registerRoutes(app);

  // Chat API endpoint for Driver Logistics & Rescheduling Assistant
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, history, activeShipment, driverProfile } = req.body;

      const bedrockClient = getBedrockAgentCoreClient();
      if (bedrockClient) {
        try {
          // Confirmed via smoke test: the agent requires a top-level `prompt`
          // string; the other fields are extra context it opportunistically
          // reads (e.g. it pulled a driver ID out of driverProfile).
          const rawBody = await invokeAgentCore({ prompt: message, history, activeShipment, driverProfile });
          const replyText = extractAgentReplyText(rawBody);
          if (replyText) {
            return res.json({ text: replyText });
          }
          console.warn('Bedrock AgentCore returned a response we could not parse, falling back to canned responses. Raw body:', rawBody);
        } catch (err) {
          console.error('Bedrock AgentCore invocation failed, falling back to canned responses:', err);
        }
      }

      // Fallback response if Bedrock AgentCore is not configured or unavailable
      const lowerMsg = (message || '').toLowerCase();
      let responseText = `Copy that, driver! I'm FleetPulse Dispatch Co-pilot. `;
      let actionObj = null;

      if (lowerMsg.includes('reschedule') || lowerMsg.includes('eta') || lowerMsg.includes('late') || lowerMsg.includes('delay')) {
        responseText += `I can process a rescheduling request for shipment ${activeShipment?.id || 'your shipment'}. I will log a 45-minute delay note and notify the receiving facility dock manager.`;
        actionObj = {
          actionType: 'RESCHEDULE_OR_ISSUE',
          category: 'traffic_delay',
          title: 'Reschedule & Delay Request',
          description: `Driver requested rescheduling due to route conditions (${message}).`,
          estimatedDelayMinutes: 45,
          suggestedNewEta: `${activeShipment?.plannedEta || 'Today'} (+45m Delay)`,
        };
      } else if (lowerMsg.includes('breakdown') || lowerMsg.includes('flat') || lowerMsg.includes('engine') || lowerMsg.includes('repair')) {
        responseText += `Safety first! I am logging a Mechanical Breakdown alert for dispatch and requesting emergency roadside assistance.`;
        actionObj = {
          actionType: 'RESCHEDULE_OR_ISSUE',
          category: 'breakdown',
          title: 'Mechanical Breakdown Alert',
          description: `Vehicle maintenance issue reported: ${message}`,
          estimatedDelayMinutes: 120,
          suggestedNewEta: 'Pending Roadside Assistance',
        };
      } else if (lowerMsg.includes('dock') || lowerMsg.includes('gate') || lowerMsg.includes('detention') || lowerMsg.includes('waiting')) {
        responseText += `Noted dock detention/access delay. Dispatch will log detention time starting now to ensure accurate driver compensation and notify facility managers.`;
        actionObj = {
          actionType: 'RESCHEDULE_OR_ISSUE',
          category: 'late_departure',
          title: 'Facility Dock Detention Delay',
          description: `Driver delayed at loading/unloading dock: ${message}`,
          estimatedDelayMinutes: 60,
          suggestedNewEta: `${activeShipment?.plannedEta || 'Today'} (+1h Dock Delay)`,
        };
      } else if (lowerMsg.includes('status') || lowerMsg.includes('load') || lowerMsg.includes('where') || lowerMsg.includes('info')) {
        if (activeShipment) {
          responseText += `Active Load ${activeShipment.id}: Traveling to ${activeShipment.destinationFacility?.name} in ${activeShipment.destinationFacility?.city}. Planned ETA: ${activeShipment.latestEtaUpdate?.declaredEta || activeShipment.plannedEta}.`;
        } else {
          responseText += `You currently have no active shipment assigned. Check the 'Accept Loads' tab to accept available hauls!`;
        }
      } else {
        responseText += `I'm standing by to assist with shipment rescheduling, traffic updates, breakdown alerts, or dispatch questions. Type what you need or pick an option below.`;
      }

      if (actionObj) {
        responseText += `\n\n\`\`\`action\n${JSON.stringify(actionObj, null, 2)}\n\`\`\``;
      }

      return res.json({ text: responseText });
    } catch (err: any) {
      console.error('Chat error:', err);
      return res.status(500).json({ error: 'Failed to process chat message', details: err.message });
    }
  });

  // Catch unmatched /api/* requests explicitly and log them — otherwise they'd
  // fall through to the SPA catch-all below and silently return index.html
  // (200 OK) instead of a 404, hiding a missing/misspelled route.
  app.use('/api', (req, res) => {
    console.warn(`[server] 404 — no API route matched ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
  });

  return app;
}
