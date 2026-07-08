import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface ApiGatewayProps {
  // The Cognito User Pool — kept for potential future admin routes
  userPool: cognito.IUserPool;
}

export class ApiGateway extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly chatResource: apigateway.Resource;
  public readonly chatHistoryResource: apigateway.Resource;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    // The main REST API — this is the URL the frontend app calls
    this.api = new apigateway.RestApi(this, 'GccApi', {
      restApiName: 'GCC-VolunteerAssistant-API',
      description: 'REST API for the GCC AI Volunteer Support Assistant',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,   // max 100 requests/sec per user
        throttlingBurstLimit: 200,  // allow short bursts up to 200
      },
      // CORS — lets the browser-based frontend call this API.
      // No credentials: the chat API is public and uses no cookies, and
      // `Access-Control-Allow-Credentials: true` is invalid with `*` origins.
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
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
  }
}
