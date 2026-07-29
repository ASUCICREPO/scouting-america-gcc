# User Guide

This guide explains how volunteers, families, and Grand Canyon Council administrators use Scout AI.

## Prerequisites

- A current version of Chrome, Edge, Safari, or Firefox
- Internet access
- A microphone-enabled browser for voice input
- A GCC administrator account in the Cognito `admin` group for dashboard access

The application must already be deployed. Operators should use the [Deployment Guide](./deploymentGuide.md).

## Public Chat

### Start A Conversation

1. Open the frontend URL supplied by GCC.
2. Select a suggested question or type a question in the message field.
3. Use the send button or press Enter.
4. Wait for the structured response. Scout AI can include headings, lists, and source references.
5. Ask a follow-up question in the same conversation when more detail is needed.

The chat does not require an account. Do not enter medical records, youth-protection reports, payment data, or other sensitive personal information.

### Good Question Examples

- What can you tell me about Camp Geronimo?
- What training do I need as a new volunteer?
- Which forms should I bring to summer camp?
- How does the Eagle Scout service project approval process work?
- Where can I find Grand Canyon Council recruitment resources?

Spanish examples:

- ¿Qué me puedes contar sobre Camp Geronimo?
- ¿Qué capacitación necesito como nuevo voluntario?
- ¿Qué formularios debo llevar al campamento de verano?

Questions work best when they name the program, camp, form, process, or audience involved.

### Change Language

1. Open the sidebar or mobile menu.
2. Select **Settings**.
3. Under **Appearance**, select **EN** or **ES**.

The selected language applies across the public chatbot, login page, and admin dashboard. It is remembered in the current browser.

If a conversation already contains messages, changing the language opens a confirmation dialog. Confirming starts a new empty conversation so English and Spanish turns are not mixed. Opening an older conversation restores the language saved with that conversation.

### Use Voice Features

Select the microphone button to speak a question. The browser may request microphone permission. Review the captured text, then confirm or cancel it.

Assistant messages include a speaker control when browser speech synthesis is available. Select it to read the answer aloud; select it again to stop playback.

Voice behavior depends on browser support and device permissions. Typing remains available when speech recognition is unsupported.

### Review Sources

When the knowledge base returns source documents, the response includes source references. Use sources to identify the approved GCC or Scouting America material behind an answer.

Scout AI can make mistakes. Verify dates, prices, safety requirements, policies, and official procedures against the cited document or with GCC staff before acting.

### Rate A Response

Use the thumbs-up or thumbs-down button on an assistant message. The rating is saved against that exact response and appears in the protected dashboard. Selecting the other rating changes the stored value.

Ratings help administrators identify useful answers and conversations that require review. They are not emergency or safeguarding reports.

### Open Chat History

1. Open the sidebar or mobile menu.
2. Choose a saved conversation.
3. Scout AI retrieves the stored transcript and restores its recorded language.

The browser keeps a local list of up to 20 session references. Clearing browser storage removes that local list but does not delete server-side quality logs.

### Start A New Chat

Select **New chat** in the sidebar. This clears the visible conversation and starts a new session when the next question is sent.

### Adjust Appearance

Open **Settings** to change:

- **Language:** English or Spanish
- **Dark Mode:** light or dark chat appearance
- **Text Size:** 12 through 20 pixels

Settings are stored in the current browser. The admin dashboard has its own appearance controls for light/dark theme and small/medium/large text, while sharing the same language selection.

### Install Scout AI

Supported browsers can show an **Add Scout AI to your home screen** card.

- Select **Install** to open the browser installation flow.
- Select the close icon to collapse the card.
- Select the download icon to show the card again.

If the browser does not provide an install prompt, use its normal **Add to Home Screen** or **Install app** menu. The install control is hidden when the application already runs in standalone mode.

## Safety And Escalation

Scout AI is not monitored as an emergency communications channel. For immediate danger or medical emergencies, call 911. For youth-protection or safeguarding concerns, follow official Scouting America and Grand Canyon Council reporting procedures and contact qualified staff directly.

The system can flag safety-related wording or low-confidence answers for administrative review. Automated escalation does not replace contacting emergency services, council leadership, a unit leader, or an authorized reporting channel.

## Admin Dashboard

### Sign In

1. Open `/admin` on the same frontend domain. Opening `/dashboard` without a current admin session redirects here automatically.
2. Enter the email address and permanent password for a Cognito admin account.
3. Select **Login**.

Only users whose Cognito token contains the `admin` group can enter the dashboard. Expired or unauthorized sessions return to the login page.

### Change Dashboard Language

1. Open **Settings** from the dashboard sidebar or profile menu.
2. Select the **Appearance** tab.
3. Under **Language**, choose **English** or **Español**.

The navigation, overview, feedback conversation modal, document page, settings, and login screen update together. The same browser preference also controls the public chatbot.

### Review Overview Metrics

The overview can show:

- Total conversations
- Total upvotes and downvotes
- Escalation count and rate
- Satisfaction rate
- Conversation volume over time
- Frequently asked questions
- Confidence distribution and trends
- Rated responses and complete session transcripts

Use the date or aggregation controls where available. Metrics are computed from recent DynamoDB records; a newly deployed or unused environment can show empty states.

To inspect feedback, select a rated response. The modal displays the full session and highlights the response that received the rating.

### Generate A Report

Use **Generate Report** on the overview page to download the current dashboard summary. Review the selected period and data before distributing it.

### Manage Documents

Open **Manage documents** from the dashboard navigation.

#### Upload Files Or Folders

1. Drag files or a folder onto the upload area, or select the area to browse.
2. Wait while each file uploads directly to S3.
3. Watch the progress bar and completion notification.
4. Allow time for the status to move from **Queued** or **Indexing** to **Ready**.

The dashboard file picker supports CSV, PDF, TXT, DOCX, PPTX, SVG, PNG, and JPEG. Folder uploads preserve relative paths under the S3 `uploads/` prefix.

Uploading means the file reached S3; **Ready** means a completed Bedrock ingestion job covers it. Large batches can take several minutes.

#### Download Documents

Select a document and use **Download**. The dashboard requests a temporary five-minute download URL.

#### Delete Documents

Select one or more documents, choose **Delete**, and confirm. Deletion removes the raw upload and its knowledge-base copy, then starts a new ingestion job. The answer corpus may take time to reflect the deletion.

### Dashboard Settings

The Settings page provides:

- Profile fields stored in the current browser
- Profile image and logo preview stored in the current browser
- Light and dark dashboard themes
- English and Spanish language selection
- Small, medium, and large text sizes

Profile and branding edits are local interface preferences; they do not update Cognito user attributes or shared GCC branding in AWS.

### Sign Out

Use **Logout** from the navigation or profile menu. This removes the stored admin tokens and returns to `/admin`.

## Frequently Asked Questions

### Can Scout AI replace official policies or training?

No. It helps locate and summarize approved information. Official publications, required training, council staff, and qualified leaders remain authoritative.

### Why did the answer say information was unavailable?

The relevant document may not be in the knowledge base, may still be indexing, or may not match the wording of the question. Add the program or document name and try again. Administrators can review the source library and ingestion status.

### Why did changing language clear my chat?

The reset prevents one session from mixing response-language contracts. Previously saved conversations remain available in chat history.

### Are conversations private?

Chat turns are logged for response quality, feedback, analytics, and escalation. Authorized administrators can review rated session transcripts. Do not submit sensitive personal information.

### Can I submit an incident report in the chat?

No. Use the official safeguarding, emergency, and council reporting channels.

### Why is the install button not working?

The browser only exposes the install prompt when its PWA requirements are met. Use the browser's own install menu or Add to Home Screen option if available.

## Troubleshooting

### The Chat Does Not Respond

- Confirm the device is online.
- Refresh the page and try a shorter question.
- Check whether other pages on the same frontend URL load.
- If the issue persists, provide the time of the request to an administrator so CloudWatch logs can be checked.

### The Interface Language Did Not Change

- Confirm the selection in **Settings > Appearance**.
- Finish the confirmation dialog if the chat already had messages.
- Refresh the page.
- If browser storage is disabled, the setting may not persist between visits.

### A Saved Conversation Does Not Open

- Confirm the API is reachable.
- The local session reference may point to a different deployment environment.
- Starting a deployment with a different resource prefix uses a different chat-log table.

### Dashboard Redirects To Login

- Sign in again; the ID token may have expired.
- Confirm the Cognito user belongs to the `admin` group.
- Confirm the frontend was built with the correct User Pool, client ID, and dashboard API URL.

### A Document Remains Pending Or Failed

- Wait for any active ingestion job to finish.
- Refresh the document list.
- Ask an operator to check the document-processor CloudWatch logs, dead-letter queue, and Bedrock ingestion job status.

## Getting Help

- For GCC program or policy questions, contact the Grand Canyon Council through [scoutingAZ.org](https://scoutingaz.org/).
- For application defects, open an issue in the project repository or contact the project maintainer.
- For deployment or API problems, provide the environment prefix, AWS region, approximate time, route, and visible error without including passwords or tokens.

## Related Documentation

- [API Documentation](./APIDoc.md)
- [Architecture Deep Dive](./architectureDeepDive.md)
- [Deployment Guide](./deploymentGuide.md)
