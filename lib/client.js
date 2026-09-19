// Browser half of dsh-skills-manager-plus: the "技能与命令" page inside
// Settings.
//
// Hand-written in the lazy-CJS bundle protocol
// (`window.__ModuleLoader__.load` with a factory returning cordis-plugin
// exports), so there is no build step. Everything it needs at runtime is
// already in the shell's frozen module table: React, plus the shared UI
// surface the `slots` service declares.
//
// The page is deliberately self-contained: it renders its own markup and CSS
// rather than depending on product-internal components, so it keeps working
// across harness versions that rearrange those components. What it does depend
// on is one stable contract — `settings.section`, the additive settings page
// seat — and the HTTP API of its own host half.
//
// The host half owns the truth (skill files under the harness's skill roots,
// saved-command files under <DSH_HOME>/commands). This half renders them,
// collects form input, and refreshes after a write: the skill-filesystem
// provider's directory watcher picks file changes up on its own schedule, so
// the page polls briefly for the converged state.
window.__ModuleLoader__.load({
  id: 'dsh-skills-manager-plus',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;
    var useMemo = react.useMemo;

    var NS = 'dsh-skills-manager-plus';

    /** Attribute this plugin stamps on its own settings nav row (see markNavRow). */
    var NAV_ROW_FLAG = 'data-skillsmp-nav';

    /** The dictionary, keyed for the two locales the harness ships. */
    var DICT = {
      zh: {
        nav: '技能与命令',
        title: '技能与命令',
        description: '管理可复用的技能与常用指令：查看、启用/停用、编辑、删除与添加技能，把常用提示词保存为 / 命令。',
        refresh: '刷新',
        loading: '正在加载…',
        loadFailed: '加载失败',
        retry: '重试',
        close: '关闭',
        cancel: '取消',
        confirm: '确认',
        saving: '保存中…',
        edit: '编辑',
        remove: '删除',
        saved: '已保存',
        removed: '已删除',
        langLabel: '语言',
        langAuto: '自动',
        importTitle: '导入设置',
        importHint: '关闭 .agents 技能目录后，其中所有技能将同时从模型目录与「/」调用中隐藏；重新开启会恢复由本页停用的技能，手工停用的不受影响。',
        agentsUserRoot: '启用 .agents 技能目录（用户级 ~/.agents/skills）',
        agentsProjectRoot: '启用 .agents 技能目录（项目级 <项目>/.agents/skills）',
        agentsCountOn: '已启用',
        agentsCountOff: '已停用',
        skillsTitle: '技能',
        commandsTitle: '命令',
        searchPlaceholder: '搜索技能名称或描述…',
        tabGlobal: '全局',
        tabProject: '项目',
        projectNone: '暂无已知项目。技能的「项目」目录（<项目>/.dsh/skills 与 .agents/skills）会出现在这里。',
        projectLabel: '项目',
        addSkill: '添加技能',
        addCommand: '添加命令',
        emptySkills: '该范围内还没有技能。',
        emptySkillsHint: '点击「添加技能」创建一个：内容是 Markdown，frontmatter 需要 name 与 description。',
        emptyCommands: '还没有保存任何命令。',
        emptyCommandsHint: '点击「添加命令」把常用提示词保存下来，在输入框输入 / 即可快速调用。',
        sourceUserDsh: '~/.dsh',
        sourceUserAgents: '~/.agents',
        sourceBundled: '内置',
        sourceProjectDsh: '项目 .dsh',
        sourceProjectAgents: '项目 .agents',
        readOnly: '只读',
        invalidSkill: 'frontmatter 无效',
        invocationModel: '模型可调用',
        invocationModelHint: '关闭后不再出现在技能目录，模型也无法加载。',
        invocationUser: '用户可调用（/ 手势）',
        invocationUserHint: '关闭后在输入框输入 /<技能名> 不再注入。',
        bodyPreview: '正文预览',
        commandSlashHint: '在输入框输入 /，选择命令即可把保存的提示词作为用户消息发送给模型。',
        commandHintLabel: '参数提示',
        prevPage: '上一页',
        nextPage: '下一页',
        pageOf: '第 {a} / {b} 页',
        removeSkillConfirm: '确定要删除技能「{name}」吗？将删除它的 SKILL.md 及整个技能目录。',
        removeCommandConfirm: '确定要删除命令 /{name} 吗？',
        addSkillTitle: '添加技能',
        editSkillTitle: '编辑技能',
        addCommandTitle: '添加命令',
        editCommandTitle: '编辑命令',
        fieldName: '名称',
        fieldNameHintSkill: '小写字母、数字与连字符（kebab-case），如 code-review。',
        fieldNameHintCommand: '小写字母开头，可含数字、下划线与连字符，如 deploy-check。',
        fieldDescription: '描述',
        fieldDescriptionHint: '模型据此决定何时使用该技能；会显示在技能目录中。',
        fieldWhenToUse: '何时使用（可选）',
        fieldWhenToUseHint: '补充的触发时机说明。',
        fieldScope: '保存位置',
        fieldScopeUser: '全局（~/.dsh/skills）',
        fieldScopeProject: '项目（<项目>/.dsh/skills）',
        fieldContent: '正文（Markdown）',
        fieldContentPlaceholderSkill: '# 技能指令\n\n在这里写给模型的具体步骤…',
        fieldContentPlaceholderCommand: '要保存的提示词。调用 /<命令名> 时会作为用户消息直接发送给模型。',
        fieldArgumentHint: '参数提示（可选）',
        fieldArgumentHintHint: '输入 /<命令名> 后占位符文案，如 <分支名> 或 问题描述。',
        fieldCommandDescriptionHint: '显示在 / 命令菜单中。',
        invalidName: '名称不符合要求',
        invalidDescription: '描述不能为空',
        notWritable: '目标目录不可写，改动无法保存：{path}',
        rowsCount: '{n} 项',
      },
      en: {
        nav: 'Skills & Commands',
        title: 'Skills & Commands',
        description: 'Manage reusable skills and frequent prompts: view, enable/disable, edit, delete and add skills, and save prompts as / commands.',
        refresh: 'Refresh',
        loading: 'Loading…',
        loadFailed: 'Failed to load',
        retry: 'Retry',
        close: 'Close',
        cancel: 'Cancel',
        confirm: 'Confirm',
        saving: 'Saving…',
        edit: 'Edit',
        remove: 'Delete',
        saved: 'Saved',
        removed: 'Removed',
        langLabel: 'Language',
        langAuto: 'Auto',
        importTitle: 'Import settings',
        importHint: 'Turning an .agents skill directory off hides every skill in it from both the model catalog and the "/" gesture; turning it back on restores the ones this page disabled — skills disabled by hand are left alone.',
        agentsUserRoot: 'Enable .agents skill directory (user ~/.agents/skills)',
        agentsProjectRoot: 'Enable .agents skill directory (project <project>/.agents/skills)',
        agentsCountOn: 'Enabled',
        agentsCountOff: 'Disabled',
        skillsTitle: 'Skills',
        commandsTitle: 'Commands',
        searchPlaceholder: 'Search skills by name or description…',
        tabGlobal: 'Global',
        tabProject: 'Project',
        projectNone: 'No known projects yet. Per-project skill roots (<project>/.dsh/skills and .agents/skills) will appear here.',
        projectLabel: 'Project',
        addSkill: 'Add skill',
        addCommand: 'Add command',
        emptySkills: 'No skills in this scope yet.',
        emptySkillsHint: 'Use “Add skill”: the body is Markdown and the frontmatter needs name and description.',
        emptyCommands: 'No saved commands yet.',
        emptyCommandsHint: 'Use “Add command” to save a prompt, then type / in the composer to invoke it.',
        sourceUserDsh: '~/.dsh',
        sourceUserAgents: '~/.agents',
        sourceBundled: 'Bundled',
        sourceProjectDsh: 'project .dsh',
        sourceProjectAgents: 'project .agents',
        readOnly: 'read-only',
        invalidSkill: 'invalid frontmatter',
        invocationModel: 'Model-invocable',
        invocationModelHint: 'Off hides it from the catalog; the model cannot load it.',
        invocationUser: 'User-invocable (/ gesture)',
        invocationUserHint: 'Off makes /<skill-name> plain prose again.',
        bodyPreview: 'Body preview',
        commandSlashHint: 'Type / in the composer and pick a command to send its saved prompt to the model as a user message.',
        commandHintLabel: 'Input hint',
        prevPage: 'Previous',
        nextPage: 'Next',
        pageOf: 'Page {a} of {b}',
        removeSkillConfirm: 'Delete skill “{name}”? Its SKILL.md and resource directory will be removed.',
        removeCommandConfirm: 'Delete command /{name}?',
        addSkillTitle: 'Add skill',
        editSkillTitle: 'Edit skill',
        addCommandTitle: 'Add command',
        editCommandTitle: 'Edit command',
        fieldName: 'Name',
        fieldNameHintSkill: 'Lowercase letters, digits and hyphens (kebab-case), e.g. code-review.',
        fieldNameHintCommand: 'Starts with a lowercase letter; digits, underscore and hyphen allowed, e.g. deploy-check.',
        fieldDescription: 'Description',
        fieldDescriptionHint: 'How the model decides when to use the skill; shown in the catalog.',
        fieldWhenToUse: 'When to use (optional)',
        fieldWhenToUseHint: 'Extra routing guidance.',
        fieldScope: 'Save to',
        fieldScopeUser: 'Global (~/.dsh/skills)',
        fieldScopeProject: 'Project (<project>/.dsh/skills)',
        fieldContent: 'Body (Markdown)',
        fieldContentPlaceholderSkill: '# Skill instructions\n\nConcrete steps for the model…',
        fieldContentPlaceholderCommand: 'The prompt to save. Invoking /<command> sends it as a user message.',
        fieldArgumentHint: 'Input hint (optional)',
        fieldArgumentHintHint: 'Placeholder shown after /<command>, e.g. <branch> or a question.',
        fieldCommandDescriptionHint: 'Shown in the / command menu.',
        invalidName: 'The name is not valid',
        invalidDescription: 'Description must not be empty',
        notWritable: 'The target directory is not writable, so changes cannot be saved: {path}',
        rowsCount: '{n} items',
      },
    };

    /** Translate one key, interpolating `{name}` placeholders. */
    function makeT(locale) {
      var table = DICT[locale === 'en' ? 'en' : 'zh'];
      return function t(key, params) {
        var text = table[key] !== undefined ? table[key] : DICT.zh[key] !== undefined ? DICT.zh[key] : key;
        if (params === undefined) return text;
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          return params[name] !== undefined ? String(params[name]) : match;
        });
      };
    }

    // The settings shell draws a generic gear for any section id it does not
    // know. The glyph below is a four-point spark, drawn as filled paths in
    // the shell's 16×16 nav icon language, riding a mask so it inherits
    // currentColor in both themes.
    var NAV_ICON_PATHS = [
      'M8 1.5l1.1 3.9L13 6.5l-3.9 1.1L8 11.5 6.9 7.6 3 6.5l3.9-1.1L8 1.5z',
      'M12 10.2l.55 1.95L14.5 12.7l-1.95.55L12 15.2l-.55-1.95-1.95-.55 1.95-.55.55-1.95z',
    ];

    /** The one stylesheet the page injects, using the theme's alias tokens. */
    var CSS = [
      '.smp-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.smp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.smp-head h2{margin:0 0 4px;font-size:15px;font-weight:600}',
      '.smp-head p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.smp-lang{display:inline-flex;align-items:center;gap:2px;height:30px;padding:0 2px 0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.smp-lang-glyph{font-size:11px;letter-spacing:-1px;white-space:nowrap}',
      '.smp-lang select{border:none;background:transparent;color:inherit;font:inherit;height:26px;outline:none;cursor:pointer}',
      '.smp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}',
      '.smp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.smp-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.smp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.smp-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}',
      '.smp-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.smp-btn-sm{height:26px;padding:0 9px;font-size:12px}',
      '.smp-icon{width:30px;padding:0}',
      // ── cards & rows ────────────────────────────────────────────────────
      '.smp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.smp-card-head{display:flex;align-items:center;gap:10px;padding:10px 12px;flex-wrap:wrap}',
      '.smp-card-title{font-weight:600;font-size:13px}',
      '.smp-card-count{color:var(--dsw-alias-label-secondary);font-size:12px;margin-right:auto}',
      '.smp-list{display:flex;flex-direction:column}',
      '.smp-row{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:50px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.smp-list .smp-row:first-child{border-top:none}',
      '.smp-spark{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:#fff;font-size:11px;font-weight:700}',
      '.smp-grow{flex:1 1 auto;min-width:0}',
      '.smp-name{display:flex;align-items:center;gap:6px;font-weight:500;min-width:0}',
      '.smp-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.smp-name code{font-size:12px}',
      '.smp-desc{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
      '.smp-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px}',
      '.smp-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.smp-tag-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.smp-tag-dim{text-decoration:line-through;opacity:.8}',
      '.smp-actions{display:flex;gap:6px;flex:0 0 auto}',
      '.smp-caret{width:20px;height:20px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:transform .15s ease}',
      '.smp-caret[aria-expanded="true"]{transform:rotate(0deg)}',
      '.smp-caret[aria-expanded="false"]{transform:rotate(-90deg)}',
      '.smp-body{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}',
      '.smp-body pre{margin:0;padding:10px 14px;max-height:280px;overflow:auto;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.smp-body .smp-body-label{padding:6px 14px 0;color:var(--dsw-alias-label-secondary);font-size:11px}',
      // ── switches / segmented / search / select ─────────────────────────
      '.smp-switch{position:relative;width:38px;height:22px;border-radius:11px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;padding:0;flex:0 0 auto;transition:background .15s ease}',
      '.smp-switch[data-on="true"]{background:var(--dsw-alias-state-success-primary)}',
      '.smp-switch:disabled{opacity:.5;cursor:not-allowed}',
      '.smp-switch i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s ease}',
      '.smp-switch[data-on="true"] i{transform:translateX(16px)}',
      '.smp-seg{display:inline-flex;padding:3px;gap:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.smp-seg-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.smp-seg-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.smp-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.smp-seg-on{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.10)}',
      '.smp-input,.smp-select{border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:7px 9px;font-family:inherit}',
      '.smp-search{width:200px;max-width:100%}',
      '.smp-input:focus,.smp-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      // ── import settings rows ────────────────────────────────────────────
      '.smp-import{display:flex;flex-direction:column}',
      '.smp-import-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.smp-import-row:first-child{border-top:none}',
      '.smp-import-label{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.smp-import-label b{font-weight:500;font-size:12.5px}',
      '.smp-import-label span{color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      // ── notes / pagination ──────────────────────────────────────────────
      '.smp-note{padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.smp-note-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.smp-note-error{color:var(--dsw-alias-state-error-primary)}',
      '.smp-pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.smp-pager:disabled{opacity:.4;cursor:not-allowed}',
      // ── modal ───────────────────────────────────────────────────────────
      '.smp-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);padding:24px}',
      '.smp-modal{width:min(640px,100%);max-height:86vh;display:flex;flex-direction:column;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 40px rgba(0,0,0,.28)}',
      '.smp-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.smp-modal-head h3{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0}',
      '.smp-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px}',
      '.smp-modal-body p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.smp-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.smp-field{display:flex;flex-direction:column;gap:5px}',
      '.smp-field label{font-size:12px;font-weight:500}',
      '.smp-field small{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.smp-field .smp-input,.smp-field .smp-select{width:100%;box-sizing:border-box}',
      '.smp-textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:7px 9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.55;resize:vertical}',
      '.smp-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.smp-check{display:flex;flex-direction:column;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px}',
      '.smp-check-line{display:flex;align-items:center;gap:8px;font-size:12.5px}',
      '.smp-check-line input{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;margin:0}',
      '.smp-check small{color:var(--dsw-alias-label-secondary);font-size:11px}',
      // ── settings nav row icon ────────────────────────────────────────────
      'button[' + NAV_ROW_FLAG + ']>svg:first-child{display:none}',
      'button[' + NAV_ROW_FLAG + ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;'
        + '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;'
        + '-webkit-mask-size:16px 16px;mask-size:16px 16px;'
        + '-webkit-mask-image:url("' + navIconDataUrl() + '");mask-image:url("' + navIconDataUrl() + '")}',
    ].join('\n');

    /**
     * The nav glyph as a data-URL mask image, so it takes the row's own text
     * colour (including active/hover states) in both themes.
     */
    function navIconDataUrl() {
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">'
        + NAV_ICON_PATHS.map(function (d) {
          return '<path d="' + d + '" fill="#000"/>';
        }).join('')
        + '</svg>';
      return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    /** Insert the page stylesheet once per client module instance. */
    function installStyles() {
      var id = NS + '-styles';
      if (document.getElementById(id) !== null) return;
      var tag = document.createElement('style');
      tag.id = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** The HTTP API prefix this plugin's host half registers. */
    var API_PREFIX = '/skills-manager-plus';

    /**
     * Call the host half over its loopback HTTP API, same-origin.
     * @param route - API route without the prefix, e.g. `state`.
     * @param body - JSON body; a GET is issued when it is absent.
     */
    function api(route, body) {
      var isRead = body === undefined;
      var query = '?lang=' + (localeRef.current === 'en' ? 'en' : 'zh');
      return fetch(API_PREFIX + '/' + route + query, {
        method: isRead ? 'GET' : 'POST',
        headers: isRead ? undefined : { 'content-type': 'application/json' },
        body: isRead ? undefined : JSON.stringify(body),
      }).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status);
            return payload;
          });
      });
    }

    // ── small presentational pieces ────────────────────────────────────────

    /** Inline SVG icon: one path, stroked in the current text colour. */
    function Icon(props) {
      return h(
        'svg',
        {
          width: props.size || 14,
          height: props.size || 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        props.path,
      );
    }

    var ICON_PATH = {
      plus: h('path', { d: 'M8 3v10M3 8h10' }),
      refresh: h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11' }),
      chevron: h('path', { d: 'M4 6l4 4 4-4' }),
      close: h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
      prev: h('path', { d: 'M10 3L5 8l5 5' }),
      next: h('path', { d: 'M6 3l5 5-5 5' }),
      slash: h('path', { d: 'M10.5 2.5l-5 11' }),
    };

    /** The row switch, styled as the pill toggle the rest of the UI uses. */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'smp-switch',
          'data-on': props.checked ? 'true' : 'false',
          role: 'switch',
          'aria-checked': props.checked,
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: props.onChange,
        },
        h('i', null),
      );
    }

    /** A two-option segmented control (tabs). */
    function Segmented(props) {
      return h(
        'div',
        { className: 'smp-seg', role: 'tablist', 'aria-label': props.label },
        props.options.map(function (option) {
          var active = option.value === props.value;
          return h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              className: 'smp-seg-btn' + (active ? ' smp-seg-on' : ''),
              onClick: function () {
                props.onChange(option.value);
              },
            },
            option.label,
          );
        }),
      );
    }

    /** A modal shell with a title and a body. */
    function Modal(props) {
      var onClose = props.onClose;
      useEffect(
        function () {
          function onKey(event) {
            if (event.key === 'Escape') onClose();
          }
          document.addEventListener('keydown', onKey);
          return function () {
            document.removeEventListener('keydown', onKey);
          };
        },
        [onClose],
      );
      return h(
        'div',
        {
          className: 'smp-overlay',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'smp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h(
            'div',
            { className: 'smp-modal-head' },
            h('h3', null, props.title),
            h(
              'button',
              {
                type: 'button',
                className: 'smp-btn smp-btn-sm smp-icon',
                onClick: onClose,
                'aria-label': props.closeLabel,
              },
              h(Icon, { path: ICON_PATH.close, size: 13 }),
            ),
          ),
          h('div', { className: 'smp-modal-body' }, props.children),
          props.footer !== undefined ? h('div', { className: 'smp-modal-foot' }, props.footer) : null,
        ),
      );
    }

    /** A stable row colour per name, so rows stay recognisable. */
    function rowColor(name) {
      var palette = ['#E8A33D', '#4C7EF3', '#3BB273', '#C4553C', '#8B5CF6', '#0EA5E9'];
      var sum = 0;
      for (var i = 0; i < name.length; i += 1) sum = (sum * 31 + name.charCodeAt(i)) % 997;
      return palette[sum % palette.length];
    }

    /** The spark avatar glyph: a four-point star, tinted per row. */
    function Spark(props) {
      return h(
        'div',
        { className: 'smp-spark', style: { background: rowColor(props.name) }, 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' },
          h('path', { d: 'M8 1.5l1.35 4.65L14 7.5l-4.65 1.35L8 13.5 6.65 8.85 2 7.5l4.65-1.35L8 1.5z' }),
        ),
      );
    }

    /** Source label lookup for the harness's root sources. */
    function sourceLabel(t, source) {
      var map = {
        'user-dsh': 'sourceUserDsh',
        'user-agents': 'sourceUserAgents',
        bundled: 'sourceBundled',
        'project-dsh': 'sourceProjectDsh',
        'project-agents': 'sourceProjectAgents',
      };
      var key = map[source];
      return key === undefined ? source : t(key);
    }

    // ── nav row icon plumbing (same approach as the reference plugin) ──────

    function markNavRow(root) {
      if (root === null || typeof root.closest !== 'function') return function () {};
      var label = makeT(localeRef.current)('nav');
      var panel = root.closest('[class*="panel"]');
      var scope = panel === null ? document : panel;
      var cells = scope.querySelectorAll('button[class*="navCell"]');
      var row = null;
      for (var i = 0; i < cells.length; i += 1) {
        var text = cells[i].textContent;
        if (text !== null && text.trim() === label) {
          row = cells[i];
          break;
        }
      }
      if (row === null) return function () {};
      row.setAttribute(NAV_ROW_FLAG, '');
      return function () {
        row.removeAttribute(NAV_ROW_FLAG);
      };
    }

    function watchNavRow() {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
        return function () {};
      }
      var scheduled = false;
      function scan() {
        scheduled = false;
        var label = makeT(localeRef.current)('nav');
        var cells = document.querySelectorAll('button[class*="navCell"]');
        for (var i = 0; i < cells.length; i += 1) {
          var text = cells[i].textContent;
          if (text !== null && text.trim() === label && !cells[i].hasAttribute(NAV_ROW_FLAG)) {
            cells[i].setAttribute(NAV_ROW_FLAG, '');
          }
        }
      }
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(scan, 100);
      }
      var observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      schedule();
      return function () {
        observer.disconnect();
      };
    }

    // ── language plumbing ──────────────────────────────────────────────────

    var LANG_KEY = 'dsh-skills-manager-plus:lang';
    var LANG_MODES = ['auto', 'zh', 'en'];

    function readLangPref() {
      try {
        var stored = localStorage.getItem(LANG_KEY);
        return LANG_MODES.indexOf(stored) !== -1 ? stored : 'auto';
      } catch (error) {
        return 'auto';
      }
    }

    function writeLangPref(mode) {
      try {
        localStorage.setItem(LANG_KEY, mode);
      } catch (error) {
        // ignore — the switch itself still works for this session
      }
    }

    function browserLocale() {
      try {
        var languages = navigator.languages || [navigator.language];
        for (var i = 0; i < languages.length; i += 1) {
          var code = typeof languages[i] === 'string' ? languages[i].slice(0, 2).toLowerCase() : '';
          if (code === 'zh') return 'zh';
          if (code === 'en') return 'en';
        }
      } catch (error) {
        // fall through
      }
      return 'zh';
    }

    var langPrefRef = { current: readLangPref() };
    var shellLocaleRef = { current: null };
    var localeRef = {
      current: langPrefRef.current === 'auto' ? browserLocale() : langPrefRef.current,
    };

    // ── rows ───────────────────────────────────────────────────────────────

    /** One expandable skill row, with its body preview beneath it. */
    function SkillRow(props) {
      var t = props.t;
      var skill = props.skill;
      var expanded = props.expanded;
      var busy = props.busy;
      var readOnly = skill.readOnly === true;
      var broken = skill.invalid != null;
      var editable = !readOnly && !broken;

      var actions = [];
      if (editable) {
        actions.push(
          h('button', { key: 'edit', type: 'button', className: 'smp-btn smp-btn-sm', disabled: busy, onClick: props.onEdit }, t('edit')),
        );
      }
      if (!readOnly) {
        actions.push(
          h('button', { key: 'remove', type: 'button', className: 'smp-btn smp-btn-sm smp-btn-danger', disabled: busy, onClick: props.onRemove }, t('remove')),
        );
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'smp-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'smp-caret',
              'aria-expanded': expanded,
              'aria-label': expanded ? t('close') : t('bodyPreview'),
              onClick: props.onExpand,
            },
            h(Icon, { path: ICON_PATH.chevron, size: 13 }),
          ),
          h(Spark, { name: skill.name }),
          h(
            'div',
            { className: 'smp-grow' },
            h('div', { className: 'smp-name' }, h('span', { title: skill.path }, skill.name)),
            h('div', { className: 'smp-desc', title: skill.description }, skill.description || '—'),
            h(
              'div',
              { className: 'smp-tags' },
              h('span', { className: 'smp-tag' }, sourceLabel(t, skill.source)),
              readOnly ? h('span', { className: 'smp-tag' }, t('readOnly')) : null,
              broken ? h('span', { className: 'smp-tag smp-tag-warn' }, t('invalidSkill')) : null,
              skill.modelInvocable === false ? h('span', { className: 'smp-tag smp-tag-dim' }, t('invocationModel')) : null,
              skill.userInvocable === false ? h('span', { className: 'smp-tag smp-tag-dim' }, t('invocationUser')) : null,
            ),
          ),
          actions.length > 0 ? h('div', { className: 'smp-actions' }, actions) : null,
          h(Switch, {
            checked: skill.enabled !== false,
            disabled: busy || readOnly || broken,
            label: skill.name,
            onChange: props.onToggle,
          }),
        ),
        expanded
          ? h(
              'div',
              { className: 'smp-body' },
              h('div', { className: 'smp-body-label' }, t('bodyPreview')),
              h('pre', null, props.body === undefined ? (props.bodyLoading ? t('loading') : '') : props.body),
            )
          : null,
      );
    }

    /** One saved-command row. */
    function CommandRow(props) {
      var t = props.t;
      var command = props.command;
      var busy = props.busy;
      var broken = command.invalid != null;
      return h(
        'div',
        { className: 'smp-row' },
        h('span', { className: 'smp-caret', style: { cursor: 'default' } }, h(Icon, { path: ICON_PATH.slash, size: 11 })),
        h(Spark, { name: command.name }),
        h(
          'div',
          { className: 'smp-grow' },
          h('div', { className: 'smp-name' }, h('code', { title: command.path }, '/' + command.name)),
          h('div', { className: 'smp-desc', title: command.description }, command.description || '—'),
          command.argumentHint
            ? h(
                'div',
                { className: 'smp-tags' },
                h('span', { className: 'smp-tag' }, t('commandHintLabel') + ': ' + command.argumentHint),
              )
            : null,
          broken ? h('div', { className: 'smp-tags' }, h('span', { className: 'smp-tag smp-tag-warn' }, t('invalidSkill'))) : null,
        ),
        h(
          'div',
          { className: 'smp-actions' },
          broken
            ? null
            : h('button', { type: 'button', className: 'smp-btn smp-btn-sm', disabled: busy, onClick: props.onEdit }, t('edit')),
          h('button', { type: 'button', className: 'smp-btn smp-btn-sm smp-btn-danger', disabled: busy, onClick: props.onRemove }, t('remove')),
        ),
        h(Switch, {
          checked: command.enabled !== false,
          disabled: busy || broken,
          label: command.name,
          onChange: props.onToggle,
        }),
      );
    }

    // ── dialogs ────────────────────────────────────────────────────────────

    /**
     * The skill editor, used for both create and edit. Editing keeps the
     * skill's own root (a project skill stays in its project); creating picks
     * the scope explicitly.
     */
    function SkillDialog(props) {
      var t = props.t;
      var editing = props.skill != null;
      var skill = props.skill || {};
      var [form, setForm] = useState(function () {
        return {
          name: skill.name || '',
          description: skill.description || '',
          whenToUse: skill.whenToUse || '',
          modelInvocable: skill.modelInvocable !== false,
          userInvocable: skill.userInvocable !== false,
          content: '',
          scope: 'user',
          project: (props.projects[0] && props.projects[0].root) || '',
        };
      });
      var [body, setBody] = useState(editing ? null : '');
      var [error, setError] = useState(null);
      var [busy, setBusy] = useState(false);

      // Load the body for an edit; a create starts from the empty template.
      useEffect(
        function () {
          if (!editing) return;
          var alive = true;
          api('skills/read', { path: skill.path })
            .then(function (result) {
              if (alive) setBody(result.content || '');
            })
            .catch(function (failure) {
              if (alive) setBody('');
            });
          return function () {
            alive = false;
          };
        },
        [editing, skill.path],
      );

      function field(key) {
        return function (event) {
          var value = event.target.value;
          setForm(function (previous) {
            var next = Object.assign({}, previous);
            next[key] = value;
            return next;
          });
        };
      }

      function submit() {
        if (busy) return;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.name.trim())) {
          setError(t('invalidName'));
          return;
        }
        if (form.description.trim() === '') {
          setError(t('invalidDescription'));
          return;
        }
        setBusy(true);
        setError(null);
        var request = editing
          ? {
              originalPath: skill.path,
              name: form.name.trim(),
              description: form.description,
              whenToUse: form.whenToUse,
              modelInvocable: form.modelInvocable,
              userInvocable: form.userInvocable,
              content: body || '',
            }
          : {
              scope: form.scope,
              project: form.scope === 'project' ? form.project : undefined,
              name: form.name.trim(),
              description: form.description,
              whenToUse: form.whenToUse,
              modelInvocable: form.modelInvocable,
              userInvocable: form.userInvocable,
              content: body || '',
            };
        api('skills/save', request)
          .then(function (result) {
            setBusy(false);
            props.onDone(result);
          })
          .catch(function (failure) {
            setBusy(false);
            setError(String((failure && failure.message) || failure));
          });
      }

      return h(
        Modal,
        {
          title: editing ? t('editSkillTitle') : t('addSkillTitle'),
          closeLabel: t('close'),
          onClose: props.onClose,
          footer: h(
            react.Fragment,
            null,
            h('button', { type: 'button', className: 'smp-btn', onClick: props.onClose }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'smp-btn smp-btn-primary', disabled: busy || body === null, onClick: submit },
              busy ? t('saving') : t('confirm'),
            ),
          ),
        },
        !editing && props.projects.length > 0
          ? h(
              'div',
              { className: 'smp-field' },
              h('label', null, t('fieldScope')),
              h(
                'select',
                {
                  className: 'smp-select',
                  value: form.scope + (form.scope === 'project' ? ':' + form.project : ''),
                  onChange: function (event) {
                    var value = event.target.value;
                    setForm(function (previous) {
                      var next = Object.assign({}, previous);
                      if (value === 'user') next.scope = 'user';
                      else {
                        next.scope = 'project';
                        next.project = value.slice(8);
                      }
                      return next;
                    });
                  },
                },
                h('option', { value: 'user' }, t('fieldScopeUser')),
                props.projects.map(function (project) {
                  return h(
                    'option',
                    { key: project.root, value: 'project:' + project.root },
                    t('fieldScopeProject').replace('<project>', shortRoot(project.root)),
                  );
                }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldName')),
          h('input', {
            className: 'smp-input',
            style: { width: '100%', boxSizing: 'border-box' },
            value: form.name,
            spellCheck: false,
            'aria-label': t('fieldName'),
            onChange: field('name'),
            placeholder: 'my-skill',
          }),
          h('small', null, t('fieldNameHintSkill')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldDescription')),
          h('textarea', {
            className: 'smp-textarea',
            rows: 2,
            style: { fontFamily: 'inherit' },
            'aria-label': t('fieldDescription'),
            value: form.description,
            onChange: field('description'),
          }),
          h('small', null, t('fieldDescriptionHint')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldWhenToUse')),
          h('input', {
            className: 'smp-input',
            style: { width: '100%', boxSizing: 'border-box' },
            value: form.whenToUse,
            spellCheck: false,
            'aria-label': t('fieldWhenToUse'),
            onChange: field('whenToUse'),
          }),
          h('small', null, t('fieldWhenToUseHint')),
        ),
        h(
          'div',
          { className: 'smp-check' },
          h(
            'label',
            { className: 'smp-check-line' },
            h('input', {
              type: 'checkbox',
              checked: form.modelInvocable,
              onChange: function (event) {
                setForm(function (previous) {
                  return Object.assign({}, previous, { modelInvocable: event.target.checked });
                });
              },
            }),
            t('invocationModel'),
          ),
          h('small', null, t('invocationModelHint')),
          h(
            'label',
            { className: 'smp-check-line' },
            h('input', {
              type: 'checkbox',
              checked: form.userInvocable,
              onChange: function (event) {
                setForm(function (previous) {
                  return Object.assign({}, previous, { userInvocable: event.target.checked });
                });
              },
            }),
            t('invocationUser'),
          ),
          h('small', null, t('invocationUserHint')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldContent')),
          h('textarea', {
            className: 'smp-textarea',
            rows: 10,
            spellCheck: false,
            'aria-label': t('fieldContent'),
            value: body === null ? t('loading') : body,
            disabled: body === null,
            placeholder: t('fieldContentPlaceholderSkill'),
            onChange: function (event) {
              setBody(event.target.value);
            },
          }),
        ),
        error !== null ? h('div', { className: 'smp-note smp-note-error' }, error) : null,
      );
    }

    /** The saved-command editor, used for both create and edit. */
    function CommandDialog(props) {
      var t = props.t;
      var editing = props.command != null;
      var command = props.command || {};
      var [form, setForm] = useState(function () {
        return {
          name: command.name || '',
          description: command.description || '',
          argumentHint: command.argumentHint || '',
          content: command.content || '',
        };
      });
      var [error, setError] = useState(null);
      var [busy, setBusy] = useState(false);

      function field(key) {
        return function (event) {
          var value = event.target.value;
          setForm(function (previous) {
            var next = Object.assign({}, previous);
            next[key] = value;
            return next;
          });
        };
      }

      function submit() {
        if (busy) return;
        if (!/^[a-z][a-z0-9_-]*$/.test(form.name.trim())) {
          setError(t('invalidName'));
          return;
        }
        if (form.description.trim() === '') {
          setError(t('invalidDescription'));
          return;
        }
        setBusy(true);
        setError(null);
        api('commands/save', {
          originalName: editing ? command.name : undefined,
          name: form.name.trim(),
          description: form.description,
          argumentHint: form.argumentHint,
          content: form.content,
        })
          .then(function (result) {
            setBusy(false);
            props.onDone(result);
          })
          .catch(function (failure) {
            setBusy(false);
            setError(String((failure && failure.message) || failure));
          });
      }

      return h(
        Modal,
        {
          title: editing ? t('editCommandTitle') : t('addCommandTitle'),
          closeLabel: t('close'),
          onClose: props.onClose,
          footer: h(
            react.Fragment,
            null,
            h('button', { type: 'button', className: 'smp-btn', onClick: props.onClose }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'smp-btn smp-btn-primary', disabled: busy, onClick: submit },
              busy ? t('saving') : t('confirm'),
            ),
          ),
        },
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldName')),
          h('input', {
            className: 'smp-input',
            style: { width: '100%', boxSizing: 'border-box' },
            value: form.name,
            spellCheck: false,
            'aria-label': t('fieldName'),
            onChange: field('name'),
            placeholder: 'my-command',
          }),
          h('small', null, t('fieldNameHintCommand')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldDescription')),
          h('input', {
            className: 'smp-input',
            style: { width: '100%', boxSizing: 'border-box' },
            value: form.description,
            spellCheck: false,
            'aria-label': t('fieldDescription'),
            onChange: field('description'),
          }),
          h('small', null, t('fieldCommandDescriptionHint')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldArgumentHint')),
          h('input', {
            className: 'smp-input',
            style: { width: '100%', boxSizing: 'border-box' },
            value: form.argumentHint,
            spellCheck: false,
            'aria-label': t('fieldArgumentHint'),
            onChange: field('argumentHint'),
            placeholder: '<branch>',
          }),
          h('small', null, t('fieldArgumentHintHint')),
        ),
        h(
          'div',
          { className: 'smp-field' },
          h('label', null, t('fieldContent')),
          h('textarea', {
            className: 'smp-textarea',
            rows: 10,
            spellCheck: false,
            'aria-label': t('fieldContent'),
            value: form.content,
            placeholder: t('fieldContentPlaceholderCommand'),
            onChange: field('content'),
          }),
        ),
        error !== null ? h('div', { className: 'smp-note smp-note-error' }, error) : null,
      );
    }

    /** Shorten a project root for menu labels: last path segment. */
    function shortRoot(root) {
      if (typeof root !== 'string' || root === '') return '';
      var parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
      return parts[parts.length - 1] || root;
    }

    var PAGE_SIZE = 10;

    /** The settings page itself. */
    function SkillsManagerPage() {
      var [locale, setLocaleState] = useState(localeRef.current);
      var t = makeT(locale);
      var [state, setState] = useState({ status: 'loading', data: null, error: null });
      var [busyKey, setBusyKey] = useState(null);
      var [expanded, setExpanded] = useState({});
      var [bodies, setBodies] = useState({});
      var [dialog, setDialog] = useState(null);
      var [notice, setNotice] = useState(null);
      var [search, setSearch] = useState('');
      var [tab, setTab] = useState('global');
      var [projectIndex, setProjectIndex] = useState(0);
      var [page, setPage] = useState(0);
      var settleTimer = useRef(null);
      var pageRef = useRef(null);

      useEffect(function () {
        return markNavRow(pageRef.current);
      }, []);

      var load = useCallback(function (quiet) {
        if (!quiet) setState({ status: 'loading', data: null, error: null });
        return api('state')
          .then(function (data) {
            setState({ status: 'ready', data: data, error: null });
            return data;
          })
          .catch(function (failure) {
            setState({ status: 'error', data: null, error: String((failure && failure.message) || failure) });
            return null;
          });
      }, []);

      useEffect(
        function () {
          load(false);
          return function () {
            if (settleTimer.current !== null) clearTimeout(settleTimer.current);
          };
        },
        [load],
      );

      /** After a write, the provider's watcher converges on its own schedule. */
      function settle() {
        if (settleTimer.current !== null) clearTimeout(settleTimer.current);
        var attempts = 0;
        function tick() {
          attempts += 1;
          load(true).then(function () {
            if (attempts < 3) settleTimer.current = setTimeout(tick, 500);
            else settleTimer.current = null;
          });
        }
        settleTimer.current = setTimeout(tick, 400);
      }

      function setLang(mode) {
        writeLangPref(mode);
        langPrefRef.current = mode;
        var next =
          mode === 'auto'
            ? shellLocaleRef.current !== null
              ? shellLocaleRef.current
              : browserLocale()
            : mode;
        localeRef.current = next;
        setLocaleState(next);
      }

      /** Run one mutation, folding the returned state back into the page. */
      function run(key, promise, successMessage) {
        setBusyKey(key);
        return promise
          .then(function (result) {
            setBusyKey(null);
            if (result && result.state) setState({ status: 'ready', data: result.state, error: null });
            if (successMessage !== undefined) setNotice(successMessage);
            settle();
            return result;
          })
          .catch(function (failure) {
            setBusyKey(null);
            setNotice(String((failure && failure.message) || failure));
            return null;
          });
      }

      var data = state.data;
      var globalSkills = data !== null && Array.isArray(data.globalSkills) ? data.globalSkills : [];
      var projects = data !== null && Array.isArray(data.projects) ? data.projects : [];
      var commands = data !== null && Array.isArray(data.commands) ? data.commands : [];
      var agentsRoots = (data !== null && data.agentsRoots) || { user: true, project: true };
      var writable = (data !== null && data.writable) || {};

      var project = projects[Math.min(projectIndex, Math.max(projects.length - 1, 0))];
      var visibleSkills = tab === 'global' ? globalSkills : project ? project.skills : [];
      var filter = search.trim().toLowerCase();
      var filteredSkills = useMemo(
        function () {
          if (filter === '') return visibleSkills;
          return visibleSkills.filter(function (skill) {
            return (
              (skill.name || '').toLowerCase().indexOf(filter) !== -1 ||
              (skill.description || '').toLowerCase().indexOf(filter) !== -1
            );
          });
        },
        [visibleSkills, filter],
      );
      var pageCount = Math.max(Math.ceil(filteredSkills.length / PAGE_SIZE), 1);
      var safePage = Math.min(page, pageCount - 1);
      var pagedSkills = filteredSkills.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

      function toggleExpand(skill) {
        var key = skill.path;
        var next = !(expanded[key] === true);
        setExpanded(function (previous) {
          var copy = Object.assign({}, previous);
          copy[key] = next;
          return copy;
        });
        if (next && bodies[key] === undefined) {
          setBodies(function (previous) {
            var copy = Object.assign({}, previous);
            copy[key] = null; // loading marker
            return copy;
          });
          api('skills/read', { path: key })
            .then(function (result) {
              setBodies(function (previous) {
                var copy = Object.assign({}, previous);
                copy[key] = result.content || '';
                return copy;
              });
            })
            .catch(function (failure) {
              setBodies(function (previous) {
                var copy = Object.assign({}, previous);
                copy[key] = String((failure && failure.message) || failure);
                return copy;
              });
            });
        }
      }

      function importSwitch(scope, checked) {
        run('agents:' + scope, api('roots/agents', { scope: scope, enabled: checked }));
      }

      var skillsPane;
      if (state.status === 'loading') {
        skillsPane = h('div', { className: 'smp-note' }, t('loading'));
      } else if (state.status === 'error') {
        skillsPane = h(
          'div',
          { className: 'smp-note smp-note-error' },
          t('loadFailed') + '：' + state.error,
          ' ',
          h(
            'button',
            {
              type: 'button',
              className: 'smp-btn smp-btn-sm',
              onClick: function () {
                load(false);
              },
            },
            t('retry'),
          ),
        );
      } else if (tab === 'project' && projects.length === 0) {
        skillsPane = h('div', { className: 'smp-note' }, t('projectNone'));
      } else if (filteredSkills.length === 0) {
        skillsPane = h(
          'div',
          { className: 'smp-note' },
          h('div', null, t('emptySkills')),
          h('div', { style: { marginTop: 2 } }, t('emptySkillsHint')),
        );
      } else {
        skillsPane = h(
          'div',
          { className: 'smp-list' },
          pagedSkills.map(function (skill) {
            return h(SkillRow, {
              key: skill.path,
              t: t,
              skill: skill,
              busy: busyKey === skill.path,
              expanded: expanded[skill.path] === true,
              body: bodies[skill.path],
              bodyLoading: bodies[skill.path] === null,
              onExpand: function () {
                toggleExpand(skill);
              },
              onToggle: function () {
                run(skill.path, api('skills/toggle', { path: skill.path, enabled: skill.enabled === false }));
              },
              onEdit: function () {
                setDialog({ kind: 'skill', skill: skill });
              },
              onRemove: function () {
                if (!window.confirm(t('removeSkillConfirm', { name: skill.name }))) return;
                run(skill.path, api('skills/remove', { path: skill.path }), t('removed') + '：' + skill.name);
              },
            });
          }),
          pageCount > 1
            ? h(
                'div',
                { className: 'smp-pager' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'smp-btn smp-btn-sm',
                    disabled: safePage === 0,
                    onClick: function () {
                      setPage(safePage - 1);
                    },
                  },
                  t('prevPage'),
                ),
                h('span', null, t('pageOf', { a: safePage + 1, b: pageCount })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'smp-btn smp-btn-sm',
                    disabled: safePage >= pageCount - 1,
                    onClick: function () {
                      setPage(safePage + 1);
                    },
                  },
                  t('nextPage'),
                ),
              )
            : null,
        );
      }

      var commandsPane;
      if (state.status !== 'ready') {
        commandsPane = null;
      } else if (commands.length === 0) {
        commandsPane = h(
          'div',
          { className: 'smp-note' },
          h('div', null, t('emptyCommands')),
          h('div', { style: { marginTop: 2 } }, t('emptyCommandsHint')),
        );
      } else {
        commandsPane = h(
          'div',
          { className: 'smp-list' },
          commands.map(function (command) {
            return h(CommandRow, {
              key: command.path,
              t: t,
              command: command,
              busy: busyKey === 'command:' + command.name,
              onToggle: function () {
                run('command:' + command.name, api('commands/toggle', { name: command.name, enabled: command.enabled === false }));
              },
              onEdit: function () {
                setDialog({ kind: 'command', command: command });
              },
              onRemove: function () {
                if (!window.confirm(t('removeCommandConfirm', { name: command.name }))) return;
                run('command:' + command.name, api('commands/remove', { name: command.name }), t('removed') + '：/' + command.name);
              },
            });
          }),
        );
      }

      var addSkillDisabled =
        (tab === 'global' && writable.userSkills === false) || (tab === 'project' && writable.userSkills === false);

      return h(
        'div',
        { className: 'smp-root', ref: pageRef },
        h(
          'div',
          { className: 'smp-head' },
          h('div', null, h('h2', null, t('title')), h('p', null, t('description'))),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              'label',
              { className: 'smp-lang', title: t('langLabel') },
              h('span', { className: 'smp-lang-glyph', 'aria-hidden': 'true' }, '文A'),
              h(
                'select',
                {
                  value: langPrefRef.current,
                  onChange: function (event) {
                    setLang(event.target.value);
                  },
                  'aria-label': t('langLabel'),
                },
                h('option', { value: 'auto' }, t('langAuto')),
                h('option', { value: 'zh' }, '中文'),
                h('option', { value: 'en' }, 'English'),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'smp-btn smp-btn-sm smp-icon',
                title: t('refresh'),
                'aria-label': t('refresh'),
                disabled: state.status === 'loading',
                onClick: function () {
                  api('refresh', {}).then(function (next) {
                    if (next && next.state) setState({ status: 'ready', data: next.state, error: null });
                  });
                },
              },
              h(Icon, { path: ICON_PATH.refresh, size: 14 }),
            ),
          ),
        ),

        notice !== null
          ? h(
              'div',
              {
                className: 'smp-note',
                style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
              },
              h('span', null, notice),
              h(
                'button',
                {
                  type: 'button',
                  className: 'smp-btn smp-btn-sm',
                  onClick: function () {
                    setNotice(null);
                  },
                },
                t('close'),
              ),
            )
          : null,

        // ── 导入设置 ────────────────────────────────────────────────────
        h(
          'div',
          { className: 'smp-card' },
          h(
            'div',
            { className: 'smp-card-head' },
            h('span', { className: 'smp-card-title' }, t('importTitle')),
            h('span', { className: 'smp-card-count' }, ''),
          ),
          h(
            'div',
            { className: 'smp-import' },
            h(
              'div',
              { className: 'smp-import-row' },
              h(
                'div',
                { className: 'smp-import-label' },
                h('b', null, t('agentsUserRoot')),
                h('span', null, t('importHint')),
              ),
              h(Switch, {
                checked: agentsRoots.user !== false,
                disabled: busyKey === 'agents:user' || writable.agentsSkills === false,
                label: t('agentsUserRoot'),
                onChange: function () {
                  importSwitch('user', agentsRoots.user === false);
                },
              }),
            ),
            h(
              'div',
              { className: 'smp-import-row' },
              h(
                'div',
                { className: 'smp-import-label' },
                h('b', null, t('agentsProjectRoot')),
                h('span', null, t('importHint')),
              ),
              h(Switch, {
                checked: agentsRoots.project !== false,
                disabled: busyKey === 'agents:project',
                label: t('agentsProjectRoot'),
                onChange: function () {
                  importSwitch('project', agentsRoots.project === false);
                },
              }),
            ),
          ),
        ),

        // ── 技能 ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'smp-card' },
          h(
            'div',
            { className: 'smp-card-head' },
            h('span', { className: 'smp-card-title' }, t('skillsTitle')),
            h('span', { className: 'smp-card-count' }, t('rowsCount', { n: filteredSkills.length })),
            tab === 'project' && projects.length > 1
              ? h(
                  'select',
                  {
                    className: 'smp-select',
                    value: String(projectIndex),
                    'aria-label': t('projectLabel'),
                    onChange: function (event) {
                      setProjectIndex(Number(event.target.value) || 0);
                      setPage(0);
                    },
                  },
                  projects.map(function (item, index) {
                    return h('option', { key: item.root, value: String(index) }, shortRoot(item.root));
                  }),
                )
              : null,
            h('input', {
              className: 'smp-input smp-search',
              value: search,
              placeholder: t('searchPlaceholder'),
              'aria-label': t('searchPlaceholder'),
              onChange: function (event) {
                setSearch(event.target.value);
                setPage(0);
              },
            }),
            h(
              Segmented,
              {
                label: t('skillsTitle'),
                value: tab,
                options: [
                  { value: 'global', label: t('tabGlobal') },
                  { value: 'project', label: t('tabProject') },
                ],
                onChange: function (next) {
                  setTab(next);
                  setPage(0);
                },
              },
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'smp-btn smp-btn-primary',
                disabled: state.status !== 'ready' || addSkillDisabled,
                onClick: function () {
                  setDialog({ kind: 'skill', skill: null });
                },
              },
              h(Icon, { path: ICON_PATH.plus, size: 13 }),
              t('addSkill'),
            ),
          ),
          skillsPane,
        ),

        // ── 命令 ────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'smp-card' },
          h(
            'div',
            { className: 'smp-card-head' },
            h('span', { className: 'smp-card-title' }, t('commandsTitle')),
            h('span', { className: 'smp-card-count' }, t('rowsCount', { n: commands.length })),
            h(
              'span',
              { style: { flex: '1 1 auto' } },
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'smp-btn smp-btn-primary',
                disabled: state.status !== 'ready' || writable.commands === false,
                onClick: function () {
                  setDialog({ kind: 'command', command: null });
                },
              },
              h(Icon, { path: ICON_PATH.plus, size: 13 }),
              t('addCommand'),
            ),
          ),
          state.status === 'ready'
            ? h('div', { className: 'smp-note', style: { margin: '0 12px 10px' } }, t('commandSlashHint'))
            : null,
          commandsPane,
        ),

        writable.commands === false && state.status === 'ready'
          ? h('div', { className: 'smp-note smp-note-warn' }, t('notWritable', { path: data.commandsDir }))
          : null,
        writable.userSkills === false && state.status === 'ready'
          ? h('div', { className: 'smp-note smp-note-warn' }, t('notWritable', { path: '' }).replace('{path}', '').replace('：', ''))
          : null,

        dialog !== null && dialog.kind === 'skill'
          ? h(SkillDialog, {
              t: t,
              skill: dialog.skill,
              projects: projects,
              onClose: function () {
                setDialog(null);
              },
              onDone: function (result) {
                setDialog(null);
                setNotice(t('saved') + '：' + (result && result.path ? result.path : ''));
                settle();
              },
            })
          : null,

        dialog !== null && dialog.kind === 'command'
          ? h(CommandDialog, {
              t: t,
              command: dialog.command,
              onClose: function () {
                setDialog(null);
              },
              onDone: function (result) {
                setDialog(null);
                setNotice(t('saved') + '：/' + (result && result.name ? result.name : ''));
                settle();
              },
            })
          : null,
      );
    }

    exports.name = 'dsh-skills-manager-plus';
    // `slots` must be DECLARED (see the reference plugin's note): a declared
    // service is resolved before apply() runs. `locale` stays optional.
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      installStyles();

      var locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(
          function () {
            return locale.register(NS, { zh: DICT.zh, en: DICT.en });
          },
          'dsh-skills-manager-plus: dictionaries',
        );
        try {
          var read = function () {
            var id = locale.getLocale().id === 'en' ? 'en' : 'zh';
            shellLocaleRef.current = id;
            if (langPrefRef.current === 'auto') localeRef.current = id;
          };
          read();
          ctx.effect(function () {
            return locale.subscribe(read);
          }, 'dsh-skills-manager-plus: locale mirror');
        } catch (error) {
          console.warn('[dsh-skills-manager-plus] locale mirror skipped:', error);
        }
      }

      var slots = ctx.slots;
      if (slots === undefined) {
        throw new Error(
          '[dsh-skills-manager-plus] the slots service is unavailable, so the settings page cannot be registered',
        );
      }
      ctx.effect(function () {
        return slots.inject('settings.section', function () {
          return slots.register(
            {
              name: 'settings.section',
              id: 'skills',
              order: 36,
              label: function () {
                return makeT(localeRef.current)('nav');
              },
            },
            SkillsManagerPage,
          );
        });
      }, 'dsh-skills-manager-plus: settings section');

      ctx.effect(watchNavRow, 'dsh-skills-manager-plus: nav row icon watch');
    };

    return module.exports;
  },
});
