import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PREFIX } from '../config/environment';

/**
 * Hosts the complete Next.js static export behind one CloudFront distribution.
 *
 * The public chat is served from `/`, the admin login from `/admin`, and the
 * authenticated application from `/dashboard`. CloudFront only serves static
 * assets; Cognito authorization on the dashboard API and the Lambda's admin
 * group check remain the security boundary for administrative data/actions.
 */
export class FrontendHosting extends Construct {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: PREFIX ? `${PREFIX}GCC-SecurityHeaders` : undefined,
      comment: 'Security headers for the Grand Canyon Council frontend',
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
    });

    const routeRewrite = new cloudfront.Function(this, 'RouteRewrite', {
      functionName: PREFIX ? `${PREFIX}GCC-RouteRewrite` : undefined,
      comment: 'Resolve Next.js static-export routes',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.charAt(uri.length - 1) === '/') {
    request.uri += 'index.html';
  } else {
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
      request.uri += '/index.html';
    }
  }

  return request;
}
      `),
    });

    const siteOrigin = PREFIX
      ? origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket, {
        originAccessControl: new cloudfront.S3OriginAccessControl(this, 'OriginAccessControl', {
          originAccessControlName: `${PREFIX}GCC-Frontend-OAC`,
          description: 'Private GCC frontend S3 origin',
        }),
      })
      : origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket);

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Grand Canyon Council chatbot and admin dashboard',
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: routeRewrite,
        }],
      },
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
  }
}
