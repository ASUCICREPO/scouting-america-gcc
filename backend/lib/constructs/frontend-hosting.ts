import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

/**
 * Static hosting for the Next.js frontend (built with `output: 'export'`)
 * behind CloudFront.
 *
 * - Private S3 bucket (no public access) holding the exported static site.
 * - CloudFront distribution with Origin Access Control (OAC) reading from S3.
 * - Viewer-request rewriting for exported per-route index.html files.
 * - Client-side-routing fallback for unknown routes (403/404 -> root index.html).
 *
 * deploy.sh publishes the built site with:
 *   aws s3 sync frontend/out s3://<SiteBucket> --delete
 *   aws cloudfront create-invalidation --distribution-id <Id> --paths "/*"
 */
export class FrontendHosting extends Construct {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Private bucket for the exported static site — CloudFront reads it via OAC.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Test/demo hosting — allow clean teardown (no user data lives here).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const routeRewriteFunction = new cloudfront.Function(this, 'RouteRewriteFunction', {
      comment: 'Resolve extensionless Next.js static-export routes',
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

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Scouting America GCC frontend',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: routeRewriteFunction,
        }],
      },
      defaultRootObject: 'index.html',
      // Unknown paths fall back to the public chat shell after route rewriting.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
  }
}
