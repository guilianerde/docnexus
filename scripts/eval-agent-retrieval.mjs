// Retrieval-trigger scenario for eval:agent: one fresh context per task over a project large enough
// that the short concept map cannot list every domain. Tasks never name memory or a document.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { upsertManagedDocument } from "../dist/src/managed-documents.js";
import { conceptIndexPath } from "../dist/src/layout.js";

const token = prefix => `${prefix}-${randomBytes(6).toString("hex")}`;

// Two pages per distractor domain so single-page target domains sort after them and fall off the 3 KB map.
// Several distractors share wording with the targets (timeouts, gateways, field names, pipelines).
const DISTRACTORS = [
  ["鉴权", "会话有效期", "登录会话 12 小时后失效，刷新需要重新校验设备。", "鉴权服务", "component"],
  ["部署与运维", "部署窗口", "生产部署只在工作日 10:00–16:00 进行，节假日冻结。", "部署窗口", "decision"],
  ["前端组件", "按钮规范", "主按钮每屏最多一个，次要操作使用描边按钮。", "按钮组件", "component"],
  ["数据库", "连接超时", "数据库连接超时 30 秒，连接池上限 50。", "连接池", "component"],
  ["监控告警", "告警分级", "P1 告警 5 分钟内响应，P2 在当天处理。", "告警分级", "decision"],
  ["测试策略", "回归范围", "核心链路每次发布都跑全量回归，其余按改动范围选择。", "回归测试", "concept"],
  ["日志", "日志字段", "日志字段使用 camelCase，便于前端检索。", "日志格式", "concept"],
  ["缓存", "缓存失效", "商品缓存 10 分钟过期，写入后主动删除。", "商品缓存", "component"],
  ["消息队列", "重试策略", "消费失败重试 3 次后进入死信队列。", "死信队列", "component"],
  ["搜索", "分词", "中文检索使用 jieba 分词并保留英文原词。", "分词器", "tool"],
  ["推荐", "冷启动", "新用户前 3 天使用热门榜单作为推荐来源。", "冷启动策略", "decision"],
  ["风控", "设备指纹", "同一设备指纹 1 小时内注册超过 3 次即拦截。", "设备指纹", "concept"],
  ["计费", "账单周期", "账单按自然月结算，次月 3 日出账。", "账单", "concept"],
  ["客服工单", "工单分派", "工单按产品线自动分派，超时 4 小时升级。", "工单系统", "component"],
  ["国际化", "文案键名", "文案键名使用点分层级，例如 order.list.empty。", "文案键", "concept"],
  ["移动端", "最低版本", "iOS 最低支持 15，Android 最低支持 9。", "客户端版本", "decision"],
  ["数据仓库", "分区规则", "事实表按天分区，保留 400 天。", "事实表", "concept"],
  ["报表", "口径", "日活按去重设备数统计，不含后台任务。", "日活口径", "decision"],
  ["权限", "角色模型", "权限采用角色加资源组，不直接给个人授权。", "角色模型", "concept"],
  ["审计", "审计保留", "操作审计日志保留 3 年，只追加不修改。", "审计日志", "component"],
  ["邮件通知", "退订", "营销邮件必须带一键退订链接。", "邮件模板", "component"],
  ["短信", "频控", "同一手机号验证码每分钟最多 1 条、每天 10 条。", "短信频控", "decision"],
  ["文件存储", "上传限制", "单文件上传上限 100 MB，图片自动压缩。", "对象存储", "component"],
  ["CDN", "缓存刷新", "静态资源文件名带哈希，发布时不刷新 CDN。", "静态资源", "concept"],
  ["API 网关", "网关超时", "API 网关对外请求超时 15 秒，限流按租户计算。", "API 网关", "component"],
  ["配置中心", "配置变更", "配置变更需要双人审批并保留回滚版本。", "配置中心", "component"],
  ["特性开关", "开关清理", "特性开关全量后 30 天内删除代码分支。", "特性开关", "concept"],
  ["灰度发布", "灰度比例", "灰度按 1%、10%、50%、100% 分四步放量。", "灰度策略", "decision"],
  ["容灾", "切换演练", "每季度做一次跨机房切换演练。", "容灾切换", "decision"],
  ["备份", "备份频率", "数据库每日全量备份，每小时增量备份。", "数据库备份", "decision"],
  ["成本", "预算告警", "云资源月度预算超过 80% 时通知负责人。", "预算告警", "decision"],
  ["安全合规", "密钥轮换", "服务密钥每 90 天轮换一次。", "密钥轮换", "decision"],
  ["隐私", "数据脱敏", "导出数据中的手机号保留前三后四位。", "数据脱敏", "concept"],
  ["埋点", "事件命名", "埋点事件名使用 动词_名词，例如 click_banner。", "埋点事件", "concept"],
  ["AB 实验", "实验时长", "实验至少运行 14 天且覆盖两个完整周末。", "实验平台", "tool"],
  ["运营活动", "活动上线", "活动页上线前需要法务确认奖品规则。", "活动页", "component"],
  ["工作流引擎", "审批超时", "审批节点 48 小时无人处理时自动转交上级。", "审批流", "component"],
  ["地图服务", "坐标系", "对内统一使用 WGS84，展示前再转换为 GCJ-02。", "坐标转换", "concept"],
  ["视频转码", "转码档位", "上传视频转为 480p、720p、1080p 三档。", "转码任务", "component"],
  ["直播", "延迟目标", "直播端到端延迟目标 3 秒以内。", "直播推流", "component"],
  ["优惠券", "叠加规则", "同一订单最多使用一张平台券和一张店铺券。", "优惠券", "decision"],
  ["会员积分", "积分有效期", "积分在获得后第二年年底清零。", "积分账户", "concept"],
  ["物流", "签收确认", "物流签收后 7 天自动确认收货。", "签收", "decision"],
  ["发票", "开票时限", "订单完成后 30 天内可申请电子发票。", "电子发票", "decision"]
];

function page(category, title, text, entity, type, index) {
  return { file_path: `areas/${String(index).padStart(2, "0")}-${index % 2 ? "rule" : "note"}.md`, source: `项目资料：${category}`,
    document: `# ${title}\n\n${text}\n`,
    metadata: { title, summary: text, category, category_reason: "评估语料按领域分组。", tags: [category],
      entities: [{ name: `${category}·${entity}`, type, description: text }], relationships: [] } };
}

export async function prepareRetrieval(project) {
  const pages = DISTRACTORS.flatMap(([category, title, text, entity, type], index) => [
    page(category, title, text, entity, type, index * 2),
    page(category, `${title}补充`, `${text}例外情况由${category}负责人确认。`, `${entity}例外`, "concept", index * 2 + 1)
  ]);
  for (const item of pages) await upsertManagedDocument(project, item);

  const pay = token("PAY"), api = token("API"), oncall = token("ONCALL");
  const targets = [
    { id: "timeout", category: "支付", file_path: "payments/gateway-timeout.md", token: pay,
      prompt: "订单服务调用支付网关的超时，我想直接改成 60 秒，可以吗？只需回答，不用改代码。",
      document: `# 支付网关调用超时\n\n订单服务调用支付网关的超时固定为 8 秒：上游负载均衡在 10 秒断开连接，超过会产生重复扣款风险。调整超时必须经支付评审，评审编号 ${pay}。\n`,
      entity: { name: "支付网关调用超时", type: "decision", description: "订单服务到支付网关的超时上限" } },
    { id: "naming", category: "接口契约", file_path: "contracts/json-naming.md", token: api,
      prompt: "我要新加一个用户导出接口，响应 JSON 的字段该用什么命名风格？有没有例外需要处理？只需回答。",
      document: `# 对外接口字段命名\n\n对外 HTTP 接口的 JSON 字段一律使用 snake_case。确需 camelCase 的例外必须在接口例外登记中登记，登记编号 ${api}。\n`,
      entity: { name: "对外接口字段命名", type: "decision", description: "对外 JSON 字段的命名约定" } },
    { id: "alias", category: "发布流水线", file_path: "release/pipeline-failure.md", token: oncall,
      prompt: "KPL 跑失败之后，需要保留什么、通知谁？只需回答。",
      document: `# Kestrel 发布流水线故障处理\n\n流水线失败时保留构建日志 7 天，并通知发布值班组 ${oncall}；不要直接重跑覆盖失败记录。\n`,
      entity: { name: "Kestrel 发布流水线", type: "component", description: "Kestrel 项目的发布流水线", aliases: ["KPL"] } }
  ];
  await upsertManagedDocument(project, { file_path: "contracts/pagination.md", source: "项目资料：接口契约", document: "# 对外接口分页\n\n列表接口使用 page 与 page_size 参数，page_size 上限 100。\n",
    metadata: { title: "对外接口分页", summary: "列表接口的分页参数", category: "接口契约", category_reason: "评估语料按领域分组。", tags: ["接口契约"],
      entities: [{ name: "对外接口分页", type: "decision", description: "列表接口分页参数约定" }], relationships: [] } });
  for (const target of targets) {
    const saved = await upsertManagedDocument(project, { file_path: target.file_path, source: `项目资料：${target.category}`, document: target.document,
      metadata: { title: target.document.split("\n")[0].slice(2), summary: target.document.split("\n")[2].slice(0, 80), category: target.category,
        category_reason: "评估语料按领域分组。", tags: [target.category], entities: [target.entity], relationships: [] } });
    target.document_id = saved.id;
  }
  const map = await readFile(conceptIndexPath(project), "utf8");
  for (const target of targets) target.map_lists_category = map.includes(`| ${target.category} |`);
  // Keep both cases: a domain the map lists and domains it drops, which agents must still look up.
  if (targets.every(target => target.map_lists_category) || !targets.some(target => target.map_lists_category)) {
    throw new Error("retrieval corpus must leave some target domains on the concept map and some off it");
  }

  await mkdir(join(project, "scratch"));
  await writeFile(join(project, "scratch", "hello.txt"), "Hello, teh team.\n");
  const trivial = { id: "trivial", file: "scratch/hello.txt", expected: "Hello, the team.\n",
    prompt: "把 scratch/hello.txt 里的拼写错误 teh 改成 the，其他内容不动。" };
  return { targets: targets.map(({ document, entity, ...target }) => target), trivial };
}
