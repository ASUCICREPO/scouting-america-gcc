import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface ApiGeoRestrictionProps {
  /**
   * The ARN of the API Gateway stage to associate the Web ACL with.
   * e.g. api.deploymentStage.stageArn
   */
  apiStageArn: string;

  /**
   * ISO 3166-1 alpha-2 country codes that are allowed to reach the API.
   * Defaults to US-only.
   */
  allowedCountries?: string[];
}

/**
 * US-only geo-restriction for the backend API.
 *
 * Creates a REGIONAL AWS WAFv2 Web ACL whose default action is BLOCK and
 * which only ALLOWs requests originating from the configured countries
 * (US by default). The Web ACL is associated with the API Gateway stage so
 * the public API cannot be called from outside the United States — closing
 * the bypass that would exist if we only geo-restricted the frontend edge.
 *
 * NOTE: A REGIONAL Web ACL must live in the same region as the API Gateway
 * it protects (us-east-1 for this stack).
 */
export class ApiGeoRestriction extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: ApiGeoRestrictionProps) {
    super(scope, id);

    const allowedCountries = props.allowedCountries ?? ['US'];

    // Web ACL: default BLOCK, allow only requests from allowed countries.
    this.webAcl = new wafv2.CfnWebACL(this, 'GeoWebAcl', {
      name: 'GCC-API-USOnly',
      description: 'Restricts the GCC API to United States traffic only',
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'GCC-API-USOnly',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AllowUSOnly',
          priority: 0,
          action: { allow: {} },
          statement: {
            geoMatchStatement: {
              countryCodes: allowedCountries,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'GCC-API-AllowUSOnly',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate the Web ACL with the API Gateway stage.
    new wafv2.CfnWebACLAssociation(this, 'GeoWebAclAssociation', {
      resourceArn: props.apiStageArn,
      webAclArn: this.webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'ApiWebAclArn', {
      value: this.webAcl.attrArn,
      description: 'ARN of the US-only WAF Web ACL protecting the API',
    });
  }
}
