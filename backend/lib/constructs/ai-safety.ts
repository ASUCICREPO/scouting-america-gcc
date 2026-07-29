import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { CONFIG, PREFIX } from '../config/environment';

/**
 * Versioned Bedrock controls used by response generation.
 *
 * Prompt Management owns the production prompt and Bedrock Guardrails evaluates
 * model input/output. The Lambda reads one immutable prompt version at runtime.
 */
export class AiSafety extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  public readonly promptAttackGuardrailId: string;
  public readonly promptAttackGuardrailVersion: string;
  public readonly promptId: string;
  public readonly promptVersion: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const contentFilters = ['HATE', 'INSULTS', 'SEXUAL', 'MISCONDUCT']
      .map((type): bedrock.CfnGuardrail.ContentFilterConfigProperty => ({
        type,
        inputStrength: 'HIGH',
        outputStrength: 'HIGH',
        inputAction: 'BLOCK',
        outputAction: 'BLOCK',
        inputEnabled: true,
        outputEnabled: true,
      }));

    // Evaluate violent output aggressively, but do not block user reports of
    // injuries or abuse before the emergency protocol can respond.
    contentFilters.push({
      type: 'VIOLENCE',
      inputStrength: 'HIGH',
      outputStrength: 'HIGH',
      inputAction: 'NONE',
      outputAction: 'BLOCK',
      inputEnabled: true,
      outputEnabled: true,
    });

    const responseGuardrail = new bedrock.CfnGuardrail(this, 'ResponseGuardrail', {
      name: `${PREFIX}gcc-chat-response-guardrail`,
      description: 'Input/output protections for the GCC volunteer support chatbot',
      blockedInputMessaging: 'I cannot help with that request. Please ask a question about approved GCC or Scouting America resources.',
      blockedOutputsMessaging: 'I cannot provide that response. Please contact the Grand Canyon Council for assistance.',
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: 'CLASSIC' },
        filtersConfig: contentFilters,
      },
    });
    const responseGuardrailVersion = new bedrock.CfnGuardrailVersion(this, 'ResponseGuardrailVersion', {
      guardrailIdentifier: responseGuardrail.attrGuardrailId,
      description: 'Immutable production guardrail version for the GCC chat response path',
    });

    // Prompt-attack detection evaluates only the raw user question. Applying it
    // to the rendered system prompt would classify our own instructions, XML
    // delimiters, and retrieved reference text as an attack.
    const promptAttackGuardrail = new bedrock.CfnGuardrail(this, 'PromptAttackGuardrail', {
      name: `${PREFIX}gcc-chat-prompt-attack-guardrail`,
      description: 'Prompt-attack screening for raw GCC chat questions',
      blockedInputMessaging: 'I cannot process that request. Please ask a question about approved GCC or Scouting America resources.',
      blockedOutputsMessaging: 'I cannot provide that response. Please contact the Grand Canyon Council for assistance.',
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: 'CLASSIC' },
        filtersConfig: [{
          type: 'PROMPT_ATTACK',
          inputStrength: 'HIGH',
          outputStrength: 'NONE',
          inputAction: 'BLOCK',
          outputAction: 'NONE',
          inputEnabled: true,
          outputEnabled: false,
        }],
      },
    });
    const promptAttackGuardrailVersion = new bedrock.CfnGuardrailVersion(
      this,
      'PromptAttackGuardrailVersion',
      {
        guardrailIdentifier: promptAttackGuardrail.attrGuardrailId,
        description: 'Immutable production guardrail version for raw prompt-attack screening',
      },
    );

    const promptText = fs.readFileSync(
      path.join(__dirname, '../../lambda/chat-handler/templates/chat_prompt.j2'),
      'utf8',
    );
    const prompt = new bedrock.CfnPrompt(this, 'ChatPrompt', {
      name: `${PREFIX}gcc-chat-grounded-response`,
      description: 'Grounded bilingual response prompt for the GCC volunteer support chatbot',
      defaultVariant: 'production',
      variants: [{
        name: 'production',
        modelId: `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${CONFIG.MODEL_ID}`,
        templateType: 'TEXT',
        inferenceConfiguration: {
          text: {
            maxTokens: 2000,
            temperature: 0.1,
          },
        },
        templateConfiguration: {
          text: {
            text: promptText,
            inputVariables: [
              { name: 'language_instruction' },
              { name: 'retrieval_context' },
              { name: 'question' },
            ],
          },
        },
      }],
    });
    const promptVersion = new bedrock.CfnPromptVersion(this, 'ChatPromptVersion', {
      promptArn: prompt.attrArn,
      description: 'Immutable production prompt version used by the GCC chat Lambda',
    });

    this.guardrailId = responseGuardrail.attrGuardrailId;
    this.guardrailVersion = responseGuardrailVersion.attrVersion;
    this.promptAttackGuardrailId = promptAttackGuardrail.attrGuardrailId;
    this.promptAttackGuardrailVersion = promptAttackGuardrailVersion.attrVersion;
    this.promptId = prompt.attrId;
    this.promptVersion = promptVersion.attrVersion;
  }
}
