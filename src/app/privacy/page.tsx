import type { Metadata } from "next";
import type { ReactNode } from "react";
import { REPO_URL } from "@/lib/app-info";
import { KEEP_DAYS } from "@/lib/usage";
import { readConfigSafe, vaultDir } from "@/lib/vault";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "隐私说明" };

/** Updated whenever what the instance collects changes (design §1.7). */
const UPDATED = "2026-10-13";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium">{title}</h2>
      <div className="flex flex-col gap-2 leading-relaxed text-muted">{children}</div>
    </section>
  );
}

const ext = "text-accent hover:underline";

/** What this instance keeps about the people who use it, and for how long. Public, like the rest of the site. */
export default function PrivacyPage() {
  const owners = readConfigSafe(vaultDir()).config?.owners ?? [];
  const operator = owners.length ? owners.map((o) => `@${o}`).join("、") : "本实例的运营者";
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-8 text-sm">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-medium">隐私说明</h1>
        <p className="text-[11px] text-muted">更新于 {UPDATED}</p>
      </div>

      <Section title="这是什么">
        <p>
          hebi8/market 是一个个人运营的行情看板，由 GitHub 用户 {operator} 运行在自己的服务器上，经 Cloudflare 对外提供。
          源码公开在{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={ext}>
            GitHub
          </a>
          ，下面说的每一项都能在代码里核对。本站没有广告；第三方统计脚本只有一个，见下面的「VibeCafé 作品统计」。
        </p>
      </Section>

      <Section title="访问统计">
        <p>为了了解负载、决定以后要不要限流，服务器会按天统计请求（图片、脚本等静态文件不算）。每条统计只有这些内容：</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>日期，以及请求来自公网还是运营者的内网。</li>
          <li>请求类型（页面、预取、操作、接口）和所属页面。不存在的路径一律记为「其他」，本站没有的品种代码记为通用图表页。</li>
          <li>访客标识：你的 IP 地址经过加盐哈希后的前 16 位。原始 IP 不保存，盐只在服务器上。</li>
          <li>如果你已登录，还有你的 GitHub 用户名。</li>
        </ul>
        <p>统计保留 {KEEP_DAYS} 天后自动删除，只有运营者能看到，不会出售或提供给其他人。</p>
      </Section>

      <Section title="VibeCafé 作品统计">
        <p>
          本站登记在{" "}
          <a href="https://vibecafe.ai" target="_blank" rel="noreferrer" className={ext}>
            VibeCafé
          </a>{" "}
          的作品里，每个页面都会加载它的统计脚本（vibecafe.ai/telemetry/v1.js），用来数作品的浏览量。脚本由你的浏览器直接从 vibecafe.ai 加载，每打开或切换一个页面向它上报一次：
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>上报的内容只有本站的作品标识、事件类型「浏览」和一个随机生成的访客编号。没有你正在看的页面地址，没有你的 GitHub 用户名，也没有你保存的任何内容。</li>
          <li>访客编号存在你浏览器的本地存储里，清掉本地存储就会换一个。</li>
          <li>和头像、图标这些直接加载的内容一样，VibeCafé 会看到这些请求和你的 IP、浏览器标识。</li>
          <li>浏览器开了「请勿跟踪」（Do Not Track）或 Global Privacy Control 时，脚本不生成编号，也不上报。</li>
        </ul>
      </Section>

      <Section title="Cloudflare">
        <p>
          公网访问都经过 Cloudflare 的网络，Cloudflare 会按它自己的
          <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer" className={ext}>
            隐私政策
          </a>
          处理你的 IP 地址等连接信息。
        </p>
      </Section>

      <Section title="GitHub 登录">
        <p>登录是可选的，不登录也能只读浏览运营者公开的总览和图表。登录在 GitHub 上完成，通过 GitHub App「hebi8-market」：跳转到 GitHub 授权后回来，或者在 GitHub 上输入一串登录代码（设备授权）。</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>服务器保存你的 GitHub 用户名、头像地址、登录时间，以及 GitHub 发给这次登录的访问令牌。令牌只用于应用内的反馈：以你的名义提交，以及读取最近的反馈。用「在其他设备上登录」带到另一台设备的登录不带令牌。</li>
          <li>浏览器里只有一个会话 Cookie，脚本读不到，连续 30 天没有使用后失效。退出登录会同时删除服务器上的会话。跳转登录的途中还有一个临时 Cookie，用来确认回来的是同一个浏览器，10 分钟后失效。</li>
          <li>你的头像图片由浏览器直接从 GitHub 加载。</li>
        </ul>
      </Section>

      <Section title="你保存的内容">
        <p>
          登录后，你的自选、画线、笔记、日志和告警会保存在服务器上属于你的目录里。其他用户看不到它们，但这些是服务器上的普通文件，运营者在技术上可以读取。请不要在里面写敏感信息。
        </p>
        <p>如果你设置了通知，服务器会保存你的 Telegram 会话 ID 或 webhook 地址，只用来发送你设置的告警。</p>
        <p>
          如果你在「设置」里生成了给 agent 用的令牌，服务器只保存它的哈希，以及你起的名字、权限、创建和最后使用的日期；令牌本身只在生成时显示一次。拿着令牌的程序能以你的身份读取你保存的内容，可写的令牌还能修改，所以只交给你信任的程序，不用了就在「设置」里吊销。
        </p>
      </Section>

      <Section title="从 TradingView 导入">
        <p>
          在「设置」里从 TradingView 布局导入画线时，你填的 sessionid 和 sessionid_sign 两个 Cookie 只随「获取布局」和「取画线」这两次请求发到服务器，由服务器转发给 tradingview.com 列出你的布局、取画线，不保存、不写日志，也不出现在错误信息里。导入的自选和画线和你自己加的一样，存在你的目录里。
        </p>
      </Section>

      <Section title="反馈">
        <p>
          通过应用提交的反馈会成为公开 GitHub 仓库里的 issue，任何人都能看到。除了你写的内容，还会附上当前页面信息、浏览器标识、最近的前端报错和应用版本。
        </p>
      </Section>

      <Section title="浏览器本地存储">
        <p>界面偏好（面板开关、画线模式等）和还没保存成功的草稿存在你浏览器的本地存储里，不会发到服务器。上面说的 VibeCafé 访客编号也存在这里。</p>
      </Section>

      <Section title="行情数据">
        <p>行情由服务器向 Yahoo、TradingView、Binance 等数据源请求，你的浏览器不会直接连接它们，它们也拿不到你的 IP。</p>
        <p>
          例外是搜索框里的图标：标的和交易所的小图标由你的浏览器直接从 TradingView 的 CDN（s3-symbol-logo.tradingview.com）加载，和 GitHub 头像一样，TradingView 会看到这些图片请求和你的 IP。
        </p>
      </Section>

      <Section title="删除和联系">
        <p>
          想删除你的数据（目录里的内容、会话、通知设置、统计里的用户名），或者对这份说明有疑问，请在
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={ext}>
            仓库的 issue
          </a>
          里联系运营者。
        </p>
      </Section>
    </main>
  );
}
