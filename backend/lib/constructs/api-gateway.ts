import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { CONFIG } from '../config/environment';

export interface ApiGatewayProps {
  allowedOrigin: string;
}

export class ApiGateway extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly chatResource: apigateway.Resource;
  public readonly chatHistoryResource: apigateway.Resource;
  public readonly chatFeedbackResource: apigateway.Resource;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    // The main REST API — this is the URL the frontend app calls
    this.api = new apigateway.RestApi(this, 'GccApi', {
      restApiName: 'GCC-VolunteerAssistant-API',
      description: 'REST API for the GCC AI Volunteer Support Assistant',
      deployOptions: {
        stageName: 'prod',
        // Shared stage protection. Per-caller generation limits are enforced
        // separately by the regional WAF rate-based rule.
        throttlingRateLimit: CONFIG.PUBLIC_API_THROTTLING_RATE_LIMIT,
        throttlingBurstLimit: CONFIG.PUBLIC_API_THROTTLING_BURST_LIMIT,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [props.allowedOrigin],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Session-Token',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // Routes — Lambda integrations get added later in backend-stack.ts
    // POST /chat — volunteer sends a question here (public, no auth)
    this.chatResource = this.api.root.addResource('chat');

    // GET /chat/history/{sessionId} — volunteer retrieves past conversation
    const historyResource = this.chatResource.addResource('history');
    this.chatHistoryResource = historyResource.addResource('{sessionId}');

    // POST /chat/feedback — volunteer rates a response thumbs up/down (public)
    this.chatFeedbackResource = this.chatResource.addResource('feedback');
  }
}
