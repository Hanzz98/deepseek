'use strict';

const { DeepSeekClient } = require('./index');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = new DeepSeekClient({
    requestsPerSecond: 1,
    burstSize: 3,
    concurrency: 2,
    maxRetries: 3,
    baseDelayMs: 1000,
  });

  const loginResult = await client.login('-+-@gmail.com', '-'); //temporary-mail.net
  console.log(JSON.stringify({ step: 'login', result: loginResult }, null, 2));

  let uploadedFile = null;
  const testImagePath = path.join(__dirname, 'test.jpg');

  if (fs.existsSync(testImagePath)) {
    try {
      console.log(`Reading file: ${testImagePath}`);
      const fileBuffer = fs.readFileSync(testImagePath);
      const filename = 'test.jpg';
      const mimeType = 'image/jpeg';

      console.log('Uploading file...');
      uploadedFile = await client.uploadFile(fileBuffer, filename, mimeType);
      console.log(JSON.stringify({ step: 'upload_file', result: uploadedFile }, null, 2));

      console.log(`Waiting for file ${uploadedFile.id} to be ready...`);
      const readyFile = await client.waitForFileReady(uploadedFile.id, {
        maxAttempts: 15,
        intervalMs: 2000,
      });
      console.log(JSON.stringify({ step: 'file_ready', result: readyFile }, null, 2));

      if (readyFile.previewable) {
        const previewUrl = await client.getPreviewUrl(uploadedFile.id);
        console.log(JSON.stringify({ step: 'preview_url', result: { url: previewUrl } }, null, 2));
      } else {
        console.log('File is not previewable.');
      }

      if (readyFile.status === 'CONTENT_EMPTY') {
        console.log('File content is empty, cannot be used in chat.');
        uploadedFile = null;
      }
    } catch (err) {
      console.error('File upload failed:', err);
      uploadedFile = null;
    }
  } else {
    console.log('\ntest.jpg not found. Skipping file upload test.');
  }

  const sessionResult = await client.createChatSession({
    agentId: 'chat',
    characterId: 1,
  });
  console.log(JSON.stringify({ step: 'create_session', result: sessionResult }, null, 2));

  const sessionId = sessionResult.session_id;

  if (uploadedFile) {
    try {
      const chatWithFileResult = await client.chat(
        sessionId,
        'apa ini?',
        {
          thinkingEnabled: false,
          searchEnabled: false,
          refFileIds: [uploadedFile.id],
        }
      );
      console.log(JSON.stringify({ step: 'chat_with_file', result: chatWithFileResult }, null, 2));
    } catch (err) {
      console.error('Error chat with file:', err);
    }
  }

  const chatResult = await client.chat(
    sessionId,
    'nama ku hann cuy, salam kenal',
    {
      thinkingEnabled: true,
      searchEnabled: false,
    }
  );
  console.log(JSON.stringify({ step: 'chat_completion', result: chatResult }, null, 2));

  const followUp = await client.chat(
    sessionId,
    'sekali lagi nama ku siapa?',
    {
      thinkingEnabled: false,
    }
  );
  console.log(JSON.stringify({ step: 'follow_up', result: followUp }, null, 2));

  const history = client.getLocalSession(sessionId);
  console.log(JSON.stringify({ step: 'session_history', result: history }, null, 2));

  const clientState = client.toJSON();
  console.log(JSON.stringify({ step: 'client_state', result: clientState }, null, 2));

  await client.logout();
  console.log(JSON.stringify({ step: 'logout', result: { ok: true } }, null, 2));
}

main().catch(err => {
  console.error(
    JSON.stringify(
      {
        error: err.name || 'Error',
        code: err.code,
        msg: err.message,
        data: err.data || null,
      },
      null,
      2
    )
  );
  process.exit(1);
});
