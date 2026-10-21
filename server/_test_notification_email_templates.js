const assert = require('node:assert/strict');
const { test } = require('node:test');
const db = require('./config/db');
const { taskAssignedEmail, taskMentionEmail } = require('./services/emailTemplates');
const { hasSelectedMention } = require('./services/taskActivityService');

test('assignment email escapes user content and uses the tenant route', () => {
  process.env.APP_BASE_URL = 'https://workhub.example';
  db.__runWithTenantContext({ tenantPool: { query() {} }, companySlug: 'acme' }, () => {
    const email = taskAssignedEmail({
      taskTitle: '<script>alert(1)</script>', taskNumber: 12,
      projectName: 'Project & Team', actorName: 'Alice', recipientName: 'Bob',
      taskId: 42, recipientRole: 'admin', status: 'backlog', priority: 'High',
    });
    assert.match(email.subject, /Task assigned:/);
    assert.match(email.html, /&lt;script&gt;/);
    assert.doesNotMatch(email.html, /<script>/);
    assert.match(email.html, /Project &amp; Team/);
    assert.match(email.html, /https:\/\/workhub\.example\/acme\/admin\/task-workspace\/42/);
    assert.match(email.text, /<script>alert\(1\)<\/script>/);
  });
});

test('mention email preserves multiline text and escapes HTML', () => {
  process.env.APP_BASE_URL = 'https://workhub.example';
  const email = taskMentionEmail({
    authorName: 'Alice', body: '@Bob please review\n<b>urgent</b>',
    taskTitle: 'Review', taskNumber: 4, taskId: 4,
  });
  assert.match(email.html, /&lt;b&gt;urgent&lt;\/b&gt;/);
  assert.match(email.text, /please review\n<b>urgent<\/b>/);
});

test('mention matching requires a complete token and excludes email addresses', () => {
  assert.equal(hasSelectedMention('@Shafiq please review', 'Shafiq'), true);
  assert.equal(hasSelectedMention('@Shafiqa please review', 'Shafiq'), false);
  assert.equal(hasSelectedMention('person@Shafiq.com', 'Shafiq'), false);
  assert.equal(hasSelectedMention('@Alice (QA) please review', 'Alice (QA)'), true);
});
