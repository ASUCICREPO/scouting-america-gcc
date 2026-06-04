import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface ApiGatewayProps {
  // The Cognito User Pool — we need this to verify user login tokens
  userPool: cognito.IUserPool;
}

export class ApiGateway extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly authorizer: apigateway.CognitoUserPoolsAuthorizer;
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
      // CORS — lets the browser-based frontend call this API
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
        allowCredentials: true,
      },
    });

    // Cognito authorizer — checks if user is logged in before allowing access
    this.authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
      authorizerName: 'GCC-CognitoAuthorizer',
      identitySource: 'method.request.header.Authorization',
    });

    // Routes — Lambda integrations get added later in backend-stack.ts
    // POST /chat — volunteer sends a question here
    this.chatResource = this.api.root.addResource('chat');

    // GET /chat/history/{sessionId} — volunteer retrieves past conversation
    const historyResource = this.chatResource.addResource('history');
    this.chatHistoryResource = historyResource.addResource('{sessionId}');
  }
}
