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
 * - Client-side-routing-friendly error handling (403/404 -> index.html).
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

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Scouting America GCC frontend',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      // Next static export emits per-route HTML; serve index.html for
      // access-denied (missing key) so client navigation still resolves.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });
  }
}
