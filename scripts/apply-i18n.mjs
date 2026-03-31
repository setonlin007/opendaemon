#!/usr/bin/env node
/**
 * Apply all i18n changes to index.html in one atomic write.
 * Run: node scripts/apply-i18n.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

const FILE = 'public/index.html';
let html = readFileSync(FILE, 'utf8');

function replace(from, to) {
  if (!html.includes(from)) {
    console.warn('⚠️  NOT FOUND:', from.substring(0, 80));
    return;
  }
  html = html.replace(from, to);
}

function replaceAll(from, to) {
  html = html.split(from).join(to);
}

// ═══════════════════════════════════════════
// 1. Add i18n.js script tag in <head>
// ═══════════════════════════════════════════
replace('<title>OpenDaemon</title>', '<title>OpenDaemon</title>\n<script src="i18n.js"></script>');

// ═══════════════════════════════════════════
// 2. Static HTML: data-i18n attributes
// ═══════════════════════════════════════════

// Sidebar header buttons
replace('onclick="toggleSidebarSearch()" title="Search"', 'onclick="toggleSidebarSearch()" data-i18n-title="search" title="Search"');
replace('onclick="openAboutPanel()" title="Docs"', 'onclick="openAboutPanel()" data-i18n-title="docs" title="Docs"');

// New Chat button
replace(`        New Chat
      </button>`, `        <span data-i18n="newChat">New Chat</span>
      </button>`);

// Search input
replace('placeholder="Search conversations..." oninput', 'data-i18n-placeholder="searchConversations" placeholder="Search conversations..." oninput');

// Sidebar footer labels
replace(`<span class="footer-label">Engines</span>`, `<span class="footer-label" data-i18n="engines">Engines</span>`);
replace(`<span class="footer-label">Files</span>`, `<span class="footer-label" data-i18n="files">Files</span>`);
replace(`<span class="footer-label">Memory</span>`, `<span class="footer-label" data-i18n="memory">Memory</span>`);

// Add language toggle button (before logout)
replace(
  `    <button class="footer-btn" onclick="window.location.href='/api/logout'">`,
  `    <button class="footer-btn" onclick="I18N.toggleLocale()" title="Switch Language">
      <span class="footer-icon">🌐</span>
      <span class="footer-label lang-toggle-label">EN</span>
    </button>
    <button class="footer-btn" onclick="window.location.href='/api/logout'">`
);
replace(`<span class="footer-label">Logout</span>`, `<span class="footer-label" data-i18n="logout">Logout</span>`);

// Context menu
replace(`    Rename
  </div>
  <div class="conv-ctx-divider"></div>
  <div class="conv-ctx-item danger" onclick="ctxDeleteConv()">`, `    <span data-i18n="rename">Rename</span>
  </div>
  <div class="conv-ctx-divider"></div>
  <div class="conv-ctx-item danger" onclick="ctxDeleteConv()">`);
replace(`    Delete
  </div>
</div>`, `    <span data-i18n="delete">Delete</span>
  </div>
</div>`);

// Chat header
replace('id="engineLabel">Select an engine</span>', 'id="engineLabel" data-i18n="selectEngine">Select an engine</span>');
replace('id="statusBadge">Ready</span>', 'id="statusBadge" data-i18n="ready">Ready</span>');

// Welcome message
replace('>Select or create a conversation to start</div>', ' data-i18n="welcomeMsg">Select or create a conversation to start</div>');

// Scroll button
replace('onclick="scrollToBottomManual()">↓ New messages</button>', 'onclick="scrollToBottomManual()" data-i18n="newMessages">↓ New messages</button>');

// Input area
replace('onclick="toggleVoiceMode()" title="Switch to voice"', 'onclick="toggleVoiceMode()" data-i18n-title="switchToVoice" title="Switch to voice"');
replace('id="voiceTooltip">Listening...</span>', 'id="voiceTooltip" data-i18n="listening">Listening...</span>');
replace('placeholder="Message OpenDaemon..." rows', 'data-i18n-placeholder="messagePlaceholder" placeholder="Message OpenDaemon..." rows');
replace('id="voiceHoldBtn">Hold to Talk</button>', 'id="voiceHoldBtn" data-i18n="holdToTalk">Hold to Talk</button>');
replace('onclick="triggerFileSelect()" title="Attach files"', 'onclick="triggerFileSelect()" data-i18n-title="attachFiles" title="Attach files"');
replace('onclick="sendMessage()" disabled title="Send"', 'onclick="sendMessage()" disabled data-i18n-title="send" title="Send"');
replace('>Enter to send · Shift+Enter for newline</div>', ' data-i18n="inputHint">Enter to send · Shift+Enter for newline</div>');

// Voice overlay
replace('id="voiceOverlayText">Release to send</div>', 'id="voiceOverlayText" data-i18n="releaseToSend">Release to send</div>');
replace('>↑ Slide up to cancel</div>', ' data-i18n="slideToCancel">↑ Slide up to cancel</div>');

// About nav
replace(`switchAboutTab('intro',this)">产品介绍</div>`, `switchAboutTab('intro',this)" data-i18n="aboutIntro">产品介绍</div>`);
replace(`switchAboutTab('guide',this)">使用指南</div>`, `switchAboutTab('guide',this)" data-i18n="aboutGuide">使用指南</div>`);
replace(`switchAboutTab('features',this)">功能说明</div>`, `switchAboutTab('features',this)" data-i18n="aboutFeatures">功能说明</div>`);
replace(`switchAboutTab('changelog',this)">版本历史</div>`, `switchAboutTab('changelog',this)" data-i18n="aboutChangelog">版本历史</div>`);

// Evo tabs
replace(`switchEvoTab('knowledge',this)">Knowledge</div>`, `switchEvoTab('knowledge',this)"><span data-i18n="knowledge">Knowledge</span></div>`);
replace(`switchEvoTab('goals',this)">Goals</div>`, `switchEvoTab('goals',this)"><span data-i18n="goals">Goals</span></div>`);
replace(`switchEvoTab('reflect',this)">Reflect</div>`, `switchEvoTab('reflect',this)"><span data-i18n="reflect">Reflect</span></div>`);
replace(`switchEvoTab('pending',this)">Pending `, `switchEvoTab('pending',this)"><span data-i18n="pending">Pending</span> `);
replace(`switchEvoTab('stats',this)">Stats</div>`, `switchEvoTab('stats',this)"><span data-i18n="stats">Stats</span></div>`);
replace(`switchEvoTab('agents',this)">Agents</div>`, `switchEvoTab('agents',this)"><span data-i18n="agents">Agents</span></div>`);
replace(`switchEvoTab('experiments',this)">A/B</div>`, `switchEvoTab('experiments',this)"><span data-i18n="ab">A/B</span></div>`);
replace(`switchEvoTab('tools',this)">Tools `, `switchEvoTab('tools',this)"><span data-i18n="tools">Tools</span> `);

// ═══════════════════════════════════════════
// 3. Dynamic JS: t() function calls
// ═══════════════════════════════════════════

// Conversation list
replace(`\${filter ? 'No matches' : 'No conversations yet'}`, `\${filter ? t('noMatches') : t('noConversationsYet')}`);
replace(`renderGroup('Today',`, `renderGroup(t('today'),`);
replace(`renderGroup('Yesterday',`, `renderGroup(t('yesterday'),`);
replace(`renderGroup('Earlier',`, `renderGroup(t('earlier'),`);

// Rename / Select engine
replace(`prompt('Rename conversation:', conv.title)`, `prompt(t('renameConversation'), conv.title)`);
replaceAll(`$('engineLabel').textContent = 'Select an engine'`, `$('engineLabel').textContent = t('selectEngine')`);

// Welcome / Start
replaceAll(`messagesEl.innerHTML = '<div class="welcome">Start a conversation</div>'`, `messagesEl.innerHTML = \`<div class="welcome">\${t('startConversation')}</div>\``);
replaceAll(`messagesEl.innerHTML = '<div class="welcome">Select or create a conversation to start</div>'`, `messagesEl.innerHTML = \`<div class="welcome">\${t('welcomeMsg')}</div>\``);

// Status
replace(`setStatus('busy', 'Thinking');`, `setStatus('busy', t('thinking'));`);
replaceAll(`setStatus('', 'Ready');`, `setStatus('', t('ready'));`);
replace(`setStatus('error', 'Error');`, `setStatus('error', t('error'));`);
replace(`setStatus('', 'Done');`, `setStatus('', t('done'));`);

// Loading / Thinking
replace(`<span>Thinking...</span>`, `<span>\${t('thinkingEllipsis')}</span>`);
replace(`<span>Responding...</span>`, `<span>\${t('responding')}</span>`);

// Copy
replaceAll(`onclick="copyMsg(this)">Copy</button>`, `onclick="copyMsg(this)">\${t('copy')}</button>`);
replaceAll(`btn.textContent = 'Copied!';`, `btn.textContent = t('copied');`);
replaceAll(`setTimeout(() => btn.textContent = 'Copy', 1500);`, `setTimeout(() => btn.textContent = t('copy'), 1500);`);

// Evo loading
replace(`body.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:20px;">Loading...</div>';`, `body.innerHTML = \`<div style="color:var(--text-3);text-align:center;padding:20px;">\${t('loading')}</div>\`;`);

// Knowledge tab
replace(`No knowledge yet. Run a reflection to start learning!</div>`, `\${t('noKnowledge')}</div>\`;`);
replace(`'No knowledge yet. Run a reflection to start learning!'`, `t('noKnowledge')`);
replace(`>Tags: \${esc(item.tags`, `>\${t('tags')}: \${esc(item.tags`);
replace(`· Confidence: \${(item.confidence`, `· \${t('confidence')}: \${(item.confidence`);
replace(`id="k-content-\${item.id}">Loading...</div>`, `id="k-content-\${item.id}">\${t('loading')}</div>`);
replace(`contentEl.textContent === 'Loading...'`, `contentEl.textContent === t('loading')`);
replace(`contentEl.textContent = 'Failed to load'`, `contentEl.textContent = t('failedToLoad')`);
replace(`confirm('Delete this knowledge entry?')`, `confirm(t('deleteKnowledgeConfirm'))`);

// Goals
replace(`<h3>Growth Goals</h3>`, `<h3>\${t('growthGoals')}</h3>`);
replace(`Define what your daemon should learn and improve on. This guides the reflection process.`, `\${t('goalsDesc')}`);
replace(`onclick="saveGoals()">Save Goals</button>`, `onclick="saveGoals()">\${t('saveGoals')}</button>`);
replace(`alert('Goals saved!');`, `alert(t('goalsSaved'));`);

// Reflect
replace(`: 'Never';`, `: t('never');`);
replace(`<h3>Run Reflection</h3>`, `<h3>\${t('runReflection')}</h3>`);
replace(`Strategy: <strong>`, `\${t('strategy')}: <strong>`);
replace(`</strong> · Last reflection: <strong>`, `</strong> · \${t('lastReflection')}: <strong>`);
replace(`>Engine</label>`, `>\${t('engine')}</label>`);
replace(`>Time Range</label>`, `>\${t('timeRange')}</label>`);
replace(`>Since last reflection</option>`, `>\${t('sinceLastReflection')}</option>`);
replace(`>Last 7 days</option>`, `>\${t('last7Days')}</option>`);
replace(`>Last 30 days</option>`, `>\${t('last30Days')}</option>`);
replace(`>All time</option>`, `>\${t('allTime')}</option>`);
replace(`Max traces:`, `\${t('maxTraces')}:`);
replace(`Loading preview...`, `\${t('loadingPreview')}`);
replace(`onclick="runReflection()">Start Reflection</button>`, `onclick="runReflection()">\${t('startReflection')}</button>`);
replace(`<h3>Reflection History</h3>`, `<h3>\${t('reflectionHistory')}</h3>`);
replace(`\${r.trace_count} traces · \${r.insights_accepted} accepted · \${tokens} tokens`, `\${r.trace_count} \${t('traces')} · \${r.insights_accepted} \${t('accepted')} · \${tokens} \${t('tokens')}`);
replace(`previewEl.innerHTML = 'Failed to load preview';`, `previewEl.innerHTML = t('failedToLoad');`);
replace(`btn.textContent = 'Reflecting...';`, `btn.textContent = t('reflecting');`);
replace(`btn.textContent = 'Start Reflection';`, `btn.textContent = t('startReflection');`);

// Accept/Reject insight buttons
replace(`>✓ Accept</button>`, `>✓ \${t('accept')}</button>`);
replace(`>✗ Reject</button>`, `>✗ \${t('reject')}</button>`);

// Pending tab
replace(`No pending insights. All caught up!</div>`, `\${t('noPending')}</div>\`;`);
replace(`'No pending insights. All caught up!'`, `t('noPending')`);

// A/B Experiments
replace(`<h3>A/B Experiments</h3>`, `<h3>\${t('abExperiments')}</h3>`);
replace(`>+ New Experiment</button>`, `>\${t('newExperiment')}</button>`);
replace(`No experiments yet. Create one to start A/B testing!</div>`, `\${t('noExperiments')}</div>`);
replace(`onclick="submitCreateExperiment()">Create</button>`, `onclick="submitCreateExperiment()">\${t('create')}</button>`);
replace(`display='none'">Cancel</button>`, `display='none'">\${t('cancel')}</button>`);
replace(`>Pick A</button>`, `>\${t('pickA')}</button>`);
replace(`>Pick B</button>`, `>\${t('pickB')}</button>`);
replace(`onclick="cancelExperiment(\${exp.id})">Cancel</button>`, `onclick="cancelExperiment(\${exp.id})">\${t('cancel')}</button>`);
replace(`confirm('Cancel this experiment?')`, `confirm(t('cancelExperimentConfirm'))`);
replace(`confirm(\`Declare Variant \${winner} as winner?\`)`, `confirm(t('declareWinnerConfirm', {winner}))`);

// Self-Coded Tools
replace(`<h3>Self-Coded Tools</h3>`, `<h3>\${t('selfCodedTools')}</h3>`);
replace(`Tools auto-proposed by the reflection system when it detects repeating patterns that could be automated.`, `\${t('toolsDesc')}`);
replace(`No self-coded tools yet. The system will propose tools when it detects automation opportunities during reflection.</div>`, `\${t('noTools')}</div>`);
replace(`tool.description||'No description'`, `tool.description||t('noDescription')`);
replace(`>View Code</summary>`, `>\${t('viewCode')}</summary>`);
replace(`>Approve & Install</button>`, `>\${t('approveInstall')}</button>`);
replace(`>Reject</button>`, `>\${t('reject')}</button>`);
replace(`onclick="disableTool(\${tool.id})">Disable</button>`, `onclick="disableTool(\${tool.id})">\${t('disable')}</button>`);
replace(`onclick="enableTool(\${tool.id})">Re-enable</button>`, `onclick="enableTool(\${tool.id})">\${t('reenable')}</button>`);
replace(`confirm('Validate and install this tool?')`, `confirm(t('validateToolConfirm'))`);
replace(`alert('Install failed: '`, `alert(t('installFailed') + ': '`);

// Agents tab
replace(`btn.textContent = 'Running...';`, `btn.textContent = t('running');`);
replace(`res.status ? \`Done: \${res.status}\` : 'Done'`, `res.status ? \`\${t('done')}: \${res.status}\` : t('done')`);
replace(`btn.textContent = 'Error';`, `btn.textContent = t('error');`);

// Engine management
replace(`'🤖 Agentic Engines'`, `t('agenticEngines')`);
replace(`'🔌 API Engines'`, `t('apiEngines')`);
replace(`>+ Add Engine</button>`, `>\${t('addEngine')}</button>`);
replace(`e.category === 'agentic' ? 'Agentic' : 'API'`, `e.category === 'agentic' ? t('agentic') : t('api')`);
replace(`title="Test">Test</button>`, `title="\${t('test')}">\${t('test')}</button>`);
replace(`title="Edit">Edit</button>`, `title="\${t('edit')}">\${t('edit')}</button>`);
replace(`title="Delete">✕</button>`, `title="\${t('delete')}">✕</button>`);
replace(`isEdit ? 'Edit Engine' : 'Add Engine'`, `isEdit ? t('editEngine') : t('addEngineTitle')`);
replace(`onclick="renderEnginesList()">Cancel</button>`, `onclick="renderEnginesList()">\${t('cancel')}</button>`);
replace(`onclick="testEngineForm()">Test</button>`, `onclick="testEngineForm()">\${t('test')}</button>`);
replace(`isEdit ? 'Save' : 'Add'`, `isEdit ? t('save') : t('add')`);
replace(`confirm(\`Delete engine "\${id}"?\`)`, `confirm(t('deleteEngineConfirm', {id}))`);
replace(`alert('Delete failed: '`, `alert(t('deleteFailed') + ': '`);
replace(`alert('Failed to load engine config: '`, `alert(t('failedToLoad') + ': '`);
replace(`alert('Name is required')`, `alert(t('nameRequired'))`);
replace(`alert('Please select engine type')`, `alert(t('selectEngineType'))`);
replaceAll(`alert('Base URL is required')`, `alert(t('baseUrlRequired'))`);
replace(`alert('Save failed: '`, `alert(t('saveFailed') + ': '`);
replace(`status.textContent = 'Save first to test';`, `status.textContent = t('saveFirst');`);
replace(`status.textContent = 'Testing...';`, `status.textContent = t('testing');`);
replace(`alert('Switch failed: '`, `alert(t('switchFailed') + ': '`);

// Upload
replace(`results.error || 'Upload failed'`, `results.error || t('uploadFailed')`);
replace(`reject(new Error('compression failed'))`, `reject(new Error(t('compressionFailed')))`);

// Attachments max
replace(`alert('Max 5 attachments per message')`, `alert(t('allFieldsRequired'))`);

// Experiments all fields
replace(`alert('All fields required')`, `alert(t('allFieldsRequired'))`);

// ═══════════════════════════════════════════
// 4. Add I18N.translatePage() at init
// ═══════════════════════════════════════════
replace(`// ── Start ──\ninit();`, `// ── Start ──\nI18N.translatePage();\ninit();`);

// ═══════════════════════════════════════════
// Write result
// ═══════════════════════════════════════════
writeFileSync(FILE, html);
console.log('✅ All i18n changes applied to', FILE);

// Verify
const result = readFileSync(FILE, 'utf8');
const checks = [
  ['i18n.js script', result.includes('<script src="i18n.js">')],
  ['translatePage()', result.includes('I18N.translatePage()')],
  ['data-i18n attrs', (result.match(/data-i18n="/g) || []).length > 10],
  ['t() calls', (result.match(/[^a-zA-Z_]t\('/g) || []).length > 50],
  ['lang toggle btn', result.includes('lang-toggle-label')],
];
for (const [name, ok] of checks) {
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}`);
}
