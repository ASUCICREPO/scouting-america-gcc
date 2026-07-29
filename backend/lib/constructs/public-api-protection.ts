import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { CONFIG, PREFIX } from '../config/environment';

export interface PublicApiProtectionProps {
  api: apigateway.RestApi;
}

/**
 * Applies an IP-based AWS WAF rate boundary to public answer generation.
 *
 * The public chat intentionally has no user login. CORS only constrains browser
 * JavaScript and does not stop direct HTTP clients, while API Gateway's stage
 * throttle is shared by every caller. This Web ACL therefore counts only
 * `POST /chat` requests per source IP and blocks an IP after the configured
 * five-minute allowance. History and feedback requests remain outside the
 * expensive generation rule.
 */
export class PublicApiProtection extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly blockedRequestsMetric: cloudwatch.Metric;

  constructor(scope: Construct, id: string, props: PublicApiProtectionProps) {
    super(scope, id);

    const ruleName = 'PublicChatGenerationRateLimit';
    const metricPrefix = `${PREFIX}GCCPublicChat`.replace(/[^A-Za-z0-9]/g, '');

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${PREFIX}GCC-PublicChat-WebACL`,
      description: 'Per-IP rate protection for public GCC chat generation',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${metricPrefix}WebACL`,
        // Sampled requests can retain user-entered chat text. Metrics provide
        // the required visibility without copying request bodies into WAF.
        sampledRequestsEnabled: false,
      },
      rules: [
        {
          name: ruleName,
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 300,
              limit: CONFIG.PUBLIC_CHAT_RATE_LIMIT_PER_FIVE_MINUTES,
              scopeDownStatement: {
                andStatement: {
                  statements: [
                    {
                      byteMatchStatement: {
                        fieldToMatch: { method: {} },
                        positionalConstraint: 'EXACTLY',
                        searchString: 'POST',
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                    {
                      byteMatchStatement: {
                        fieldToMatch: { uriPath: {} },
                        positionalConstraint: 'EXACTLY',
                        searchString: '/chat',
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                  ],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${metricPrefix}RateLimit`,
            sampledRequestsEnabled: false,
          },
        },
        {
          name: 'PublicApiGeneralRateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 300,
              limit: CONFIG.PUBLIC_API_RATE_LIMIT_PER_FIVE_MINUTES,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${metricPrefix}GeneralRateLimit`,
            sampledRequestsEnabled: false,
          },
        },
      ],
    });

    const stage = props.api.deploymentStage;
    const association = new wafv2.CfnWebACLAssociation(this, 'Association', {
      // API Gateway's WAF association ARN uses an empty account segment and a
      // leading slash before `restapis`, unlike most service resource ARNs.
      resourceArn: `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${props.api.restApiId}/stages/${stage.stageName}`,
      webAclArn: this.webAcl.attrArn,
    });
    association.node.addDependency(stage);

    this.blockedRequestsMetric = new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: {
        WebACL: this.webAcl.name!,
        Region: cdk.Stack.of(this).region,
        // WAF emits the Web ACL aggregate with Rule=ALL, covering both the
        // generation-specific and general public-API rate rules.
        Rule: 'ALL',
      },
      period: cdk.Duration.minutes(1),
      statistic: 'Sum',
      label: 'WAF-blocked public chat requests',
    });
  }
}
