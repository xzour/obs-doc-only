import { App, Modal, ButtonComponent, Setting } from "obsidian";

// 拉取模态框
export class PullMrdocModal extends Modal {
	onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "拉取 MrDoc 文档到本地" });
		contentEl.createEl("p", { text: "此操作将会从指定的 MrDoc 文集中拉取文档到本地 Vault 仓库。" });
		contentEl.createEl("li", { text: "Vault 内存在的同名文件，将会跳过！" });
		contentEl.createEl("li", { text: "Vault 同层级下不支持同名文件/文件夹，故 MrDoc 的同层级同名文档只同步其中一个！" });
		contentEl.createEl("li", { text: "拉取的文件将与 MrDoc 文档建立映射关系，在 Vault 内对文件进行的操作将同步至 MrDoc！" });
		contentEl.createEl("li", { text: "请谨慎进行此操作，确保没有重要文件在 Vault 仓库内！" });

		contentEl.createEl("br");

		// 使用 ButtonComponent 而不是 createEl
		const confirmButton = new ButtonComponent(contentEl)
			.setButtonText("已知晓风险，确认拉取")
			.setCta()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});

		new ButtonComponent(contentEl)
			.setButtonText("取消")
			.onClick(() => this.close());
	}
}

// 加载中模态框
export class LoadingModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "任务进行中..." });
	}
}

// 同步操作确认对话框（通用：修改/重命名/删除）
export interface SyncConfirmOptions {
	title: string;
	message: string;
	warning?: string;
	confirmText?: string;
	cancelText?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export class SyncConfirmModal extends Modal {
	private opts: Required<SyncConfirmOptions>;

	constructor(app: App, opts: SyncConfirmOptions) {
		super(app);
		this.opts = {
			confirmText: '确认同步',
			cancelText: '取消',
			warning: '',
			...opts
		};
	}

	onOpen() {
		const { contentEl } = this;
		const { title, message, warning, confirmText, cancelText } = this.opts;

		contentEl.createEl("h2", { text: title });
		contentEl.createEl("p", { text: message });
		if (warning) {
			contentEl.createEl("p", { text: warning, cls: "mod-warning" });
		}

		contentEl.createEl("br");

		new ButtonComponent(contentEl)
			.setButtonText(confirmText)
			.setWarning()
			.onClick(() => {
				this.opts.onConfirm();
				this.close();
			});

		new ButtonComponent(contentEl)
			.setButtonText(cancelText)
			.onClick(() => {
				this.opts.onCancel();
				this.close();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 拉取完成模态框
export class PulledModal extends Modal {
	infoArray: any[];

	constructor(app: App, infoArray: any[]) {
		super(app);
		this.infoArray = infoArray;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "已完成拉取！" });
		contentEl.createEl("p", { text: "已完成从 MrDoc 拉取文档到本地，详情如下：" });

		const contentDiv = contentEl.createEl("div", { cls: "pulled-modal-div" });
		this.infoArray.forEach((data) => {
			contentDiv.createEl("li", { text: data });
		});

		new ButtonComponent(contentEl)
			.setButtonText("好的")
			.setCta()
			.onClick(() => this.close());
	}
}

// ==========================================================================
// 推送（本地 → MrDoc）相关模态框
// ==========================================================================

// 推送模式：
// - full        : 全量同步（未映射则创建、已映射则更新）
// - create-only : 增量上传（仅推送未映射的文档）
// - update-only : 仅更新已映射文档（不创建新文档）
export type PushMode = 'full' | 'create-only' | 'update-only';

export interface PushOptions {
	mode: PushMode;
	includeDrafts: boolean;
}

export interface PushModalResult {
	confirmed: boolean;
	options: PushOptions;
}

// 推送本地文档到 MrDoc 的确认模态框
export class PushMrdocModal extends Modal {
	private onConfirm: (options: PushOptions) => void;
	private currentOptions: PushOptions;

	constructor(app: App, onConfirm: (options: PushOptions) => void, defaults?: Partial<PushOptions>) {
		super(app);
		this.onConfirm = onConfirm;
		this.currentOptions = {
			mode: defaults?.mode ?? 'full',
			includeDrafts: defaults?.includeDrafts ?? false,
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "推送本地文档到 MrDoc" });

		contentEl.createEl("p", {
			text: "此操作将以本地 Vault 为准，将整个 Vault 中的 Markdown / HTML 文档与文件夹批量推送到目标 MrDoc 文集。",
		});
		contentEl.createEl("li", { text: "文件夹将先于文件被推送，以确保父子层级关系正确。" });
		contentEl.createEl("li", { text: "已建立映射的文档将根据所选模式被更新（覆盖远程内容），MrDoc 历史版本仍可在服务端找回。" });
		contentEl.createEl("li", { text: "未建立映射的文档将根据所选模式被创建（新建后会写入本地映射）。" });
		contentEl.createEl("li", { text: "默认会忽略已映射但本地服务端时间不一致的冲突检测，强制以本地内容为准。" });
		contentEl.createEl("li", { text: "请确保已选定正确的目标文集，并且在 MrDoc 上不存在不希望被覆盖的内容！" });

		contentEl.createEl("br");

		// 推送模式选择
		new Setting(contentEl)
			.setName("推送模式")
			.setDesc("选择批量推送的策略")
			.addDropdown((dd) => {
				dd.addOption('full', '全量同步 - 创建未映射 + 更新已映射');
				dd.addOption('create-only', '增量上传 - 只创建未映射的文档');
				dd.addOption('update-only', '映射回写 - 只更新已映射的文档');
				dd.setValue(this.currentOptions.mode);
				dd.onChange((value) => {
					this.currentOptions.mode = value as PushMode;
				});
			});

		// 是否将新建文档默认为草稿
		new Setting(contentEl)
			.setName("新建文档默认为草稿")
			.setDesc("开启后，本次新建的文档在 MrDoc 上将以「草稿」状态保存，关闭则默认发布")
			.addToggle((tg) => {
				tg.setValue(this.currentOptions.includeDrafts);
				tg.onChange((value) => {
					this.currentOptions.includeDrafts = value;
				});
			});

		contentEl.createEl("br");

		new ButtonComponent(contentEl)
			.setButtonText("已知晓风险，开始推送")
			.setCta()
			.onClick(() => {
				this.onConfirm(this.currentOptions);
				this.close();
			});

		new ButtonComponent(contentEl)
			.setButtonText("取消")
			.onClick(() => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 推送统计计数器
export interface PushStats {
	total: number;
	processed: number;
	created: number;
	updated: number;
	skipped: number;
	failed: number;
}

// 推送进度模态框
export class PushProgressModal extends Modal {
	private headerEl: HTMLElement;
	private currentEl: HTMLElement;
	private progressBarFill: HTMLElement;
	private statsEl: HTMLElement;
	private logContainer: HTMLElement;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.headerEl = contentEl.createEl("h2", { text: "推送中…" });
		this.currentEl = contentEl.createEl("p", {
			text: "准备开始推送…",
			cls: "mrdoc-push-current",
		});

		// 进度条
		const progressBarWrap = contentEl.createEl("div", { cls: "mrdoc-push-progress-wrap" });
		this.progressBarFill = progressBarWrap.createEl("div", { cls: "mrdoc-push-progress-fill" });
		this.progressBarFill.style.width = "0%";

		// 统计行
		this.statsEl = contentEl.createEl("p", { cls: "mrdoc-push-stats", text: "已处理 0 / 0" });

		// 日志容器
		contentEl.createEl("h4", { text: "实时日志：" });
		this.logContainer = contentEl.createEl("div", { cls: "mrdoc-push-log" });
	}

	// 更新当前正在处理的项
	setCurrent(text: string) {
		if (this.currentEl) this.currentEl.setText(text);
	}

	// 更新统计数据与进度条
	updateStats(stats: PushStats) {
		if (this.statsEl) {
			this.statsEl.setText(
				`已处理 ${stats.processed} / ${stats.total}　（创建 ${stats.created}　更新 ${stats.updated}　跳过 ${stats.skipped}　失败 ${stats.failed}）`,
			);
		}
		if (this.progressBarFill) {
			const ratio = stats.total === 0 ? 0 : Math.min(1, stats.processed / stats.total);
			this.progressBarFill.style.width = `${(ratio * 100).toFixed(1)}%`;
		}
	}

	// 追加日志行
	appendLog(message: string) {
		if (!this.logContainer) return;
		const line = this.logContainer.createEl("div", { text: message });
		line.scrollIntoView({ block: "nearest" });
	}

	// 标题文本
	setHeader(text: string) {
		if (this.headerEl) this.headerEl.setText(text);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 推送结果模态框
export interface PushedDetail {
	level: 'success' | 'failed' | 'skipped';
	text: string;
}

export class PushedModal extends Modal {
	private details: PushedDetail[];
	private stats: PushStats;

	constructor(app: App, details: PushedDetail[], stats: PushStats) {
		super(app);
		this.details = details;
		this.stats = stats;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "推送完成！" });
		contentEl.createEl("p", {
			text: `已完成本地文档推送至 MrDoc，共处理 ${this.stats.processed} / ${this.stats.total} 项。`,
		});
		contentEl.createEl("p", {
			text: `创建 ${this.stats.created}　更新 ${this.stats.updated}　跳过 ${this.stats.skipped}　失败 ${this.stats.failed}`,
			cls: "mrdoc-pushed-summary",
		});

		const contentDiv = contentEl.createEl("div", { cls: "pulled-modal-div" });
		this.details.forEach((item) => {
			const cls = item.level === 'failed'
				? 'mrdoc-pushed-line-failed'
				: item.level === 'skipped'
					? 'mrdoc-pushed-line-skipped'
					: 'mrdoc-pushed-line-success';
			contentDiv.createEl("li", { text: item.text, cls });
		});

		contentEl.createEl("br");

		new ButtonComponent(contentEl)
			.setButtonText("好的")
			.setCta()
			.onClick(() => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
