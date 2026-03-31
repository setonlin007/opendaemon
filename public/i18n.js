// ── OpenDaemon i18n ──
// Lightweight internationalization system
// Usage: t('key') or t('key', { name: 'value' })

const I18N = {
  _locale: localStorage.getItem('od-lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en'),
  _translations: {},

  get locale() { return this._locale; },

  setLocale(lang) {
    this._locale = lang;
    localStorage.setItem('od-lang', lang);
    this.translatePage();
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  },

  toggleLocale() {
    this.setLocale(this._locale === 'zh' ? 'en' : 'zh');
  },

  t(key, params) {
    const dict = this._translations[this._locale] || this._translations['en'] || {};
    let text = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
      }
    }
    return text;
  },

  // Translate all elements with data-i18n attribute
  translatePage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = this.t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.getAttribute('data-i18n-title'));
    });
    // Update lang toggle button label
    const langBtn = document.querySelector('.lang-toggle-label');
    if (langBtn) langBtn.textContent = this._locale === 'zh' ? 'EN' : '中';
  },
};

// Shorthand
function t(key, params) { return I18N.t(key, params); }

// ── Translations ──
I18N._translations = {
  en: {
    // Sidebar
    'newChat': 'New Chat',
    'searchConversations': 'Search conversations...',
    'engines': 'Engines',
    'files': 'Files',
    'memory': 'Memory',
    'logout': 'Logout',
    'logoutConfirm': 'Are you sure you want to logout?',

    // Context menu
    'rename': 'Rename',
    'delete': 'Delete',

    // Chat header
    'selectEngine': 'Select an engine',
    'ready': 'Ready',

    // Messages
    'welcomeMsg': 'Select or create a conversation to start',
    'startConversation': 'Start a conversation',
    'newMessages': '↓ New messages',
    'copy': 'Copy',
    'copied': 'Copied!',

    // Input area
    'messagePlaceholder': 'Message OpenDaemon...',
    'holdToTalk': 'Hold to Talk',
    'releaseToSend': 'Release to send',
    'slideToCancel': '↑ Slide up to cancel',
    'inputHint': 'Enter to send · Shift+Enter for newline',
    'listening': 'Listening...',
    'switchToVoice': 'Switch to voice',
    'attachFiles': 'Attach files',
    'send': 'Send',

    // Status
    'thinking': 'Thinking',
    'thinkingEllipsis': 'Thinking...',
    'responding': 'Responding...',
    'error': 'Error',
    'loading': 'Loading...',

    // Conversation list
    'today': 'Today',
    'yesterday': 'Yesterday',
    'earlier': 'Earlier',
    'noMatches': 'No matches',
    'noConversationsYet': 'No conversations yet',

    // Dialogs
    'renameConversation': 'Rename conversation:',
    'deleteKnowledgeConfirm': 'Delete this knowledge entry?',
    'deleteEngineConfirm': 'Delete engine "{id}"?',
    'cancelExperimentConfirm': 'Cancel this experiment?',
    'declareWinnerConfirm': 'Declare Variant {winner} as winner?',
    'validateToolConfirm': 'Validate and install this tool?',
    'allFieldsRequired': 'All fields required',
    'nameRequired': 'Name is required',
    'selectEngineType': 'Please select engine type',
    'baseUrlRequired': 'Base URL is required',
    'goalsSaved': 'Goals saved!',

    // About panel
    'aboutIntro': 'Product Introduction',
    'aboutGuide': 'User Guide',
    'aboutFeatures': 'Features',
    'aboutChangelog': 'Changelog',

    // Evolution panel
    'evolution': 'Evolution',
    'knowledge': 'Knowledge',
    'goals': 'Goals',
    'reflect': 'Reflect',
    'pending': 'Pending',
    'stats': 'Stats',
    'agents': 'Agents',
    'ab': 'A/B',
    'tools': 'Tools',

    // Knowledge tab
    'noKnowledge': 'No knowledge yet. Run a reflection to start learning!',
    'tags': 'Tags',
    'confidence': 'Confidence',
    'failedToLoad': 'Failed to load',

    // Goals tab
    'growthGoals': 'Growth Goals',
    'goalsDesc': 'Define what your daemon should learn and improve on. This guides the reflection process.',
    'saveGoals': 'Save Goals',

    // Reflect tab
    'runReflection': 'Run Reflection',
    'strategy': 'Strategy',
    'lastReflection': 'Last reflection',
    'never': 'Never',
    'engine': 'Engine',
    'timeRange': 'Time Range',
    'sinceLastReflection': 'Since last reflection',
    'last7Days': 'Last 7 days',
    'last30Days': 'Last 30 days',
    'allTime': 'All time',
    'maxTraces': 'Max traces',
    'loadingPreview': 'Loading preview...',
    'startReflection': 'Start Reflection',
    'reflectionHistory': 'Reflection History',
    'traces': 'traces',
    'accepted': 'accepted',
    'tokens': 'tokens',
    'reflecting': 'Reflecting...',
    'complete': 'Complete!',
    'reflectionFailed': 'Reflection failed',

    // Pending tab
    'pendingInsights': 'Pending Insights',
    'noPending': 'No pending insights. Run a reflection to generate new insights.',
    'accept': 'Accept',
    'reject': 'Reject',

    // Stats tab
    'conversations': 'Conversations',
    'messages': 'Messages',
    'knowledgeEntries': 'Knowledge',
    'reflections': 'Reflections',
    'totalFeedback': 'Feedback',
    'positiveRate': 'Positive Rate',
    'feedbackBreakdown': 'Feedback Breakdown',
    'positive': 'Positive',
    'negative': 'Negative',

    // Agents tab
    'subAgents': 'Sub-Agents',
    'noAgents': 'No sub-agent sessions yet.',
    'runEvaluation': 'Run Next Evaluation',
    'running': 'Running...',
    'done': 'Done',

    // A/B tab
    'abExperiments': 'A/B Experiments',
    'newExperiment': '+ New Experiment',
    'noExperiments': 'No experiments yet. Create one to start A/B testing!',
    'experimentName': 'Experiment name',
    'systemPrompt': 'System Prompt',
    'injectionTemplate': 'Injection Template',
    'reflectionPrompt': 'Reflection Prompt',
    'variantA': 'Variant A',
    'variantB': 'Variant B',
    'minConversations': 'Min conversations:',
    'create': 'Create',
    'cancel': 'Cancel',
    'pickA': 'Pick A',
    'pickB': 'Pick B',
    'surface': 'Surface',

    // Tools tab
    'selfCodedTools': 'Self-Coded Tools',
    'toolsDesc': 'Tools auto-proposed by the reflection system when it detects repeating patterns that could be automated.',
    'noTools': 'No self-coded tools yet. The system will propose tools when it detects automation opportunities during reflection.',
    'approveInstall': 'Approve & Install',
    'disable': 'Disable',
    'reenable': 'Re-enable',
    'viewCode': 'View Code',
    'noDescription': 'No description',
    'pattern': 'Pattern',
    'validation': 'Validation',
    'installFailed': 'Install failed',

    // Engine panel
    'addEngine': '+ Add Engine',
    'agenticEngines': '🤖 Agentic Engines',
    'apiEngines': '🔌 API Engines',
    'failedToLoadEngines': 'Failed to load engines',
    'editEngine': 'Edit Engine',
    'addEngineTitle': 'Add Engine',
    'agentic': 'Agentic',
    'api': 'API',
    'agenticDesc': 'Built-in Agent capabilities',
    'apiDesc': 'OpenDaemon provides Agent capabilities',
    'test': 'Test',
    'edit': 'Edit',
    'save': 'Save',
    'add': 'Add',
    'name': 'Name',
    'icon': 'Icon',
    'baseUrl': 'Base URL',
    'apiKey': 'API Key',
    'model': 'Model',
    'authMode': 'Auth Mode',
    'oauthOption': 'OAuth (already logged in, zero config)',
    'apikeyOption': 'API Key (Anthropic direct)',
    'customOption': 'Custom URL + Key (OpenRouter, etc.)',
    'usingOauth': 'Using local OAuth credentials from',
    'selectSdk': 'Select SDK',
    'noAgenticPlugins': 'No Agentic engine plugins installed.',
    'installPlugin': 'Install a plugin in',
    'andRestart': 'and restart.',
    'failedToLoadTypes': 'Failed to load engine types',
    'effort': 'Effort',
    'budgetLimit': 'Budget Limit (USD per conversation, optional)',
    'format': 'Format',
    'openaiCompatible': 'OpenAI Compatible',
    'anthropicCompatible': 'Anthropic Compatible',
    'connected': '✓ Connected',
    'failed': '✕ Failed',
    'testFailed': 'Test failed',
    'saveFailed': 'Save failed',
    'deleteFailed': 'Delete failed',
    'switchFailed': 'Switch failed',
    'saveFirst': 'Save first to test',
    'testing': 'Testing...',

    // File upload
    'uploadFailed': 'Upload failed',
    'compressionFailed': 'compression failed',
    'dropFiles': '📎 Drop files here',

    // Artifacts
    'artifacts': '📁 Artifacts',

    // Time
    'now': 'now',

    // Search
    'search': 'Search',
    'docs': 'Docs',

    // Connection
    'connectionError': 'Connection error',
    'loginFailed': 'Login failed',
    'password': 'Password',
    'login': 'Login',
    'tagline': 'The self-evolving agent harness',

    // Misc
    'default': 'Default',
    'optional': 'optional',
    'convs': 'convs',
  },

  zh: {
    // Sidebar
    'newChat': '新对话',
    'searchConversations': '搜索对话...',
    'engines': '引擎',
    'files': '文件',
    'memory': '记忆',
    'logout': '退出',
    'logoutConfirm': '确定要退出登录吗？',

    // Context menu
    'rename': '重命名',
    'delete': '删除',

    // Chat header
    'selectEngine': '选择引擎',
    'ready': '就绪',

    // Messages
    'welcomeMsg': '选择或创建一个对话开始',
    'startConversation': '开始一段对话',
    'newMessages': '↓ 新消息',
    'copy': '复制',
    'copied': '已复制!',

    // Input area
    'messagePlaceholder': '输入消息...',
    'holdToTalk': '按住说话',
    'releaseToSend': '松开发送',
    'slideToCancel': '↑ 上滑取消',
    'inputHint': 'Enter 发送 · Shift+Enter 换行',
    'listening': '正在聆听...',
    'switchToVoice': '切换语音',
    'attachFiles': '添加附件',
    'send': '发送',

    // Status
    'thinking': '思考中',
    'thinkingEllipsis': '思考中...',
    'responding': '回复中...',
    'error': '错误',
    'loading': '加载中...',

    // Conversation list
    'today': '今天',
    'yesterday': '昨天',
    'earlier': '更早',
    'noMatches': '无匹配结果',
    'noConversationsYet': '暂无对话',

    // Dialogs
    'renameConversation': '重命名对话:',
    'deleteKnowledgeConfirm': '确定删除此知识条目?',
    'deleteEngineConfirm': '确定删除引擎 "{id}"?',
    'cancelExperimentConfirm': '确定取消此实验?',
    'declareWinnerConfirm': '确定将变体 {winner} 设为胜出?',
    'validateToolConfirm': '验证并安装此工具?',
    'allFieldsRequired': '请填写所有字段',
    'nameRequired': '名称为必填项',
    'selectEngineType': '请选择引擎类型',
    'baseUrlRequired': 'Base URL 为必填项',
    'goalsSaved': '目标已保存!',

    // About panel
    'aboutIntro': '产品介绍',
    'aboutGuide': '使用指南',
    'aboutFeatures': '功能说明',
    'aboutChangelog': '版本历史',

    // Evolution panel
    'evolution': '进化',
    'knowledge': '知识库',
    'goals': '目标',
    'reflect': '反思',
    'pending': '待处理',
    'stats': '统计',
    'agents': '智能体',
    'ab': 'A/B',
    'tools': '工具',

    // Knowledge tab
    'noKnowledge': '暂无知识。运行一次反思来开始学习！',
    'tags': '标签',
    'confidence': '置信度',
    'failedToLoad': '加载失败',

    // Goals tab
    'growthGoals': '成长目标',
    'goalsDesc': '定义你的守护进程应该学习和改进的方向。这将指导反思过程。',
    'saveGoals': '保存目标',

    // Reflect tab
    'runReflection': '运行反思',
    'strategy': '策略',
    'lastReflection': '上次反思',
    'never': '从未',
    'engine': '引擎',
    'timeRange': '时间范围',
    'sinceLastReflection': '自上次反思以来',
    'last7Days': '最近 7 天',
    'last30Days': '最近 30 天',
    'allTime': '所有时间',
    'maxTraces': '最大追踪数',
    'loadingPreview': '加载预览中...',
    'startReflection': '开始反思',
    'reflectionHistory': '反思历史',
    'traces': '追踪',
    'accepted': '已采纳',
    'tokens': 'tokens',
    'reflecting': '反思中...',
    'complete': '完成!',
    'reflectionFailed': '反思失败',

    // Pending tab
    'pendingInsights': '待处理洞察',
    'noPending': '暂无待处理洞察。运行反思以生成新的洞察。',
    'accept': '采纳',
    'reject': '拒绝',

    // Stats tab
    'conversations': '对话',
    'messages': '消息',
    'knowledgeEntries': '知识库',
    'reflections': '反思',
    'totalFeedback': '反馈',
    'positiveRate': '好评率',
    'feedbackBreakdown': '反馈详情',
    'positive': '好评',
    'negative': '差评',

    // Agents tab
    'subAgents': '子智能体',
    'noAgents': '暂无子智能体会话。',
    'runEvaluation': '运行下一次评估',
    'running': '运行中...',
    'done': '完成',

    // A/B tab
    'abExperiments': 'A/B 实验',
    'newExperiment': '+ 新建实验',
    'noExperiments': '暂无实验。创建一个来开始 A/B 测试！',
    'experimentName': '实验名称',
    'systemPrompt': '系统提示词',
    'injectionTemplate': '注入模板',
    'reflectionPrompt': '反思提示词',
    'variantA': '变体 A',
    'variantB': '变体 B',
    'minConversations': '最少对话数:',
    'create': '创建',
    'cancel': '取消',
    'pickA': '选择 A',
    'pickB': '选择 B',
    'surface': '应用面',

    // Tools tab
    'selfCodedTools': '自编码工具',
    'toolsDesc': '当反思系统检测到可自动化的重复模式时，会自动提议工具。',
    'noTools': '暂无自编码工具。系统将在反思过程中检测到自动化机会时提议工具。',
    'approveInstall': '批准并安装',
    'disable': '禁用',
    'reenable': '重新启用',
    'viewCode': '查看代码',
    'noDescription': '暂无描述',
    'pattern': '模式',
    'validation': '验证',
    'installFailed': '安装失败',

    // Engine panel
    'addEngine': '+ 添加引擎',
    'agenticEngines': '🤖 智能体引擎',
    'apiEngines': '🔌 API 引擎',
    'failedToLoadEngines': '加载引擎失败',
    'editEngine': '编辑引擎',
    'addEngineTitle': '添加引擎',
    'agentic': '智能体',
    'api': 'API',
    'agenticDesc': '内置 Agent 能力',
    'apiDesc': 'OpenDaemon 提供 Agent 能力',
    'test': '测试',
    'edit': '编辑',
    'save': '保存',
    'add': '添加',
    'name': '名称',
    'icon': '图标',
    'baseUrl': 'Base URL',
    'apiKey': 'API Key',
    'model': '模型',
    'authMode': '认证方式',
    'oauthOption': 'OAuth（已登录，零配置）',
    'apikeyOption': 'API Key（Anthropic 直连）',
    'customOption': '自定义 URL + Key（OpenRouter 等）',
    'usingOauth': '使用本地 OAuth 凭证来自',
    'selectSdk': '选择 SDK',
    'noAgenticPlugins': '未安装智能体引擎插件。',
    'installPlugin': '在以下目录安装插件',
    'andRestart': '并重启。',
    'failedToLoadTypes': '加载引擎类型失败',
    'effort': '推理深度',
    'budgetLimit': '预算上限（每对话 USD，可选）',
    'format': '格式',
    'openaiCompatible': 'OpenAI 兼容',
    'anthropicCompatible': 'Anthropic 兼容',
    'connected': '✓ 已连接',
    'failed': '✕ 失败',
    'testFailed': '测试失败',
    'saveFailed': '保存失败',
    'deleteFailed': '删除失败',
    'switchFailed': '切换失败',
    'saveFirst': '请先保存再测试',
    'testing': '测试中...',

    // File upload
    'uploadFailed': '上传失败',
    'compressionFailed': '压缩失败',
    'dropFiles': '📎 拖放文件到此处',

    // Artifacts
    'artifacts': '📁 文件产物',

    // Time
    'now': '刚刚',

    // Search
    'search': '搜索',
    'docs': '文档',

    // Connection
    'connectionError': '连接错误',
    'loginFailed': '登录失败',
    'password': '密码',
    'login': '登录',
    'tagline': '自进化智能体框架',

    // Misc
    'default': '默认',
    'optional': '可选',
    'convs': '对话',
  },
};
