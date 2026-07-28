import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface StaticSurface {
  bucket: s3.Bucket;
  distribution: cloudfront.Distribution;
}

/**
 * Two isolated static origins for the public chat and authenticated admin UI.
 *
 * deploy.sh intentionally omits /login and /dashboard from the public bucket.
 * A viewer-request guard also denies those paths at the public edge. Admin
 * routes live in a separate S3 origin and CloudFront distribution so each API
 * can trust one distinct browser origin.
 */
export class FrontendHosting extends Construct {
  public readonly publicBucket: s3.Bucket;
  public readonly publicDistribution: cloudfront.Distribution;
  public readonly adminBucket: s3.Bucket;
  public readonly adminDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Security headers shared by GCC public and admin static sites',
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

    const publicSite = this.createSurface(
      'Public',
      'Grand Canyon Council public chat',
      false,
      securityHeaders,
    );
    const adminSite = this.createSurface(
      'Admin',
      'Grand Canyon Council admin dashboard',
      true,
      securityHeaders,
    );

    this.publicBucket = publicSite.bucket;
    this.publicDistribution = publicSite.distribution;
    this.adminBucket = adminSite.bucket;
    this.adminDistribution = adminSite.distribution;
  }

  private createSurface(
    id: string,
    comment: string,
    admin: boolean,
    securityHeaders: cloudfront.IResponseHeadersPolicy,
  ): StaticSurface {
    const bucket = new s3.Bucket(this, `${id}SiteBucket`, {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const routeRewrite = new cloudfront.Function(this, `${id}RouteRewrite`, {
      comment: `Resolve ${id.toLowerCase()} Next.js static-export routes`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  ${admin ? `
  if (uri === '/') {
    request.uri = '/login/index.html';
    return request;
  }
  ` : `
  if (uri === '/login' || uri.indexOf('/login/') === 0 ||
      uri === '/dashboard' || uri.indexOf('/dashboard/') === 0) {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: { 'cache-control': { value: 'no-store' } }
    };
  }
  `}

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

    const fallback = admin ? '/login/index.html' : '/index.html';
    const distribution = new cloudfront.Distribution(this, `${id}Distribution`, {
      comment,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: routeRewrite,
        }],
      },
      defaultRootObject: admin ? 'login/index.html' : 'index.html',
      // The public site intentionally returns real errors for unknown/admin
      // paths. The admin site falls back to login for an expired deep link.
      errorResponses: admin
        ? [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: fallback },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: fallback },
        ]
        : [],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    return { bucket, distribution };
  }
}
