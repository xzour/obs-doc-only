import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting,TAbstractFile,TFile,TFolder,normalizePath  } from 'obsidian';
import { MrdocSettingTab, MrdocPluginSettings, DEFAULT_SETTINGS, FileMapEntry } from './setting';
import Helper from "./helper";
import { MrdocApiReq } from "./api";
import {
	PullMrdocModal,
	LoadingModal,
	PulledModal,
	SyncConfirmModal,
	PushMrdocModal,
	PushProgressModal,
	PushedModal,
	PushedDetail,
	PushOptions,
	PushStats,
} from "./modals";
import { imgFileToBase64,processMrdocUrl } from './utils';
import { imageExtension } from "./extension/imageExtension";

// 单项推送的内部结果，用于批量推送结果聚合
interface PushItemResult {
	level: 'success' | 'failed' | 'skipped';
	action: 'created' | 'updated' | 'skipped' | 'failed';
	message: string;
}

// 实例化一个插件
export default class MrdocPlugin extends Plugin {
	settings: MrdocPluginSettings;
	helper: Helper;
	editor: Editor;
	req: MrdocApiReq;
	statusBar: HTMLElement;
	loadingModal: Modal;
	pullInfoArray:any[];

	async onload() {
		await this.loadSettings();

		this.req = new MrdocApiReq(this.settings,this);
		this.loadingModal = new LoadingModal(this.app);
		this.helper = new Helper(this.app);
		this.pullInfoArray = [];

		// 缓存当前登录用户名（用于协作模式下创作者识别）
		if (this.settings.mrdocToken) {
			try {
				const tokenRes = await this.req.checkToken();
				if (tokenRes.status && tokenRes.data?.username) {
					this.settings.currentUser = tokenRes.data.username;
					await this.saveSettings();
				}
			} catch (e) {
				console.warn("获取当前用户信息失败:", e);
			}
		}

		// 添加右键文件菜单
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
			  menu.addItem((item) => {
				item
				  .setTitle("同步到 MrDoc")
				  .setIcon("document")
				  .onClick(async () => {
					await this.onSyncItem(file)
				  });
			  });
			  menu.addItem((item) => {
				item
				  .setTitle("从 MrDoc 拉取")
				  .setIcon("file-down")
				  .onClick(async () => {
					await this.onPullItem(file)
				  });
			  });
			  // 发布/转草稿按钮（仅已映射文档显示）
			  const found = this.settings.fileMap.find(item => item.path === file.path);
			  if (found) {
				const isDraft = found.status === 0;
				menu.addItem((item) => {
				  item
					.setTitle(isDraft ? "发布文档" : "转为草稿")
					.setIcon(isDraft ? "upload-cloud" : "file-edit")
					.onClick(async () => {
					  await this.onToggleDocStatus(file, found);
					});
				});
			  }
			})
		  );

		// 左侧功能区 - 推送图标（本地 → MrDoc 全量/增量推送）
		const pushIconEl = this.addRibbonIcon('upload-cloud', '推送本地文档到 MrDoc', (evt: MouseEvent) => {
			this.showPushModal()
		});

		// 左侧功能区 - 拉取图标
		const pullIconEl = this.addRibbonIcon('file-down', '拉取 MrDoc 文档到本地', (evt: MouseEvent) => {
			this.showPullModal()
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status Bar Text');

		// This adds a settings tab so the user can configure various aspects of the plugin
		// 添加一个设置选项卡面板，以便用户配置插件的各个功能
		this.addSettingTab(new MrdocSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		this.createStatusBar();

		// 注册侦听文档变动事件
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on('create', this.onVaultCreate.bind(this)));
			this.registerEvent(this.app.vault.on('rename', this.onVaultRename.bind(this)));
			this.registerEvent(this.app.vault.on('modify', this.onVaultModify.bind(this)));
			this.registerEvent(this.app.vault.on('delete', this.onVaultDelete.bind(this)));	
		})

		// 注册侦听编辑器的粘贴和拖拽事件
		this.registerEvent(this.app.workspace.on('editor-paste',this.onEditorPaste.bind(this)));
		this.registerEvent(this.app.workspace.on('editor-drop',this.onEditorDrop.bind(this)));

		// markdown后处理
		this.registerMarkdownPostProcessor((element, context) => {
			const embImgs = element.querySelectorAll("div.internal-embed")
			if(embImgs.length >0){
				const embedDiv = embImgs.item(0);
				const imgSrc = processMrdocUrl(this.settings.mrdocUrl) + embedDiv.getAttribute('src')
				const imgEle = document.createElement('img')
				imgEle.src = imgSrc;
				element.removeAttribute('class');
				element.removeAttribute('src');
				element.empty();
				element.appendChild(imgEle);
			};
		});
		this.registerEditorExtension([imageExtension({plugin:this})]);
	}

	onunload() {

	}

	// 创建一个statusBar状态栏
	createStatusBar() {
		// 创建状态栏项
		this.statusBar = this.addStatusBarItem();
		this.statusBar.setText('');
	  }

	// 加载配置
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		let needSave = false;

		// 向后兼容：迁移旧 realtimeSync 到新 syncMode
		const raw = this.settings as any;
		if (raw.realtimeSync !== undefined && !raw.syncMode) {
			this.settings.syncMode = raw.realtimeSync ? 'auto' : 'manual';
			delete raw.realtimeSync;
			needSave = true;
		}

		if (needSave) await this.saveData(this.settings);
	}

	// 保存配置
	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 从 MrDoc 拉取文档
	async pullMrDoc(){
		let doc = {
			pid:this.settings.defaultProject
		}
		let docs = await this.req.getProjectDocs(doc)
		this.pullInfoArray = []
		// console.log(docs)
		if(docs.status){
			this.settings.pulling = true
			await this.saveSettings()
			// console.log("pull状态修改为true：",this.settings.pulling)
			let counter = 0;
			await this.createFilesAndFolders(docs.data,'')
			// if(counter === docs.total.length){
				this.settings.pulling = false;
				await this.saveSettings()
				// console.log("pull状态修改为false：",this.settings.pulling)
			// }
		}else{
			let msg = "【拉取失败】MrDoc 文档"
			new Notice(msg)
			this.pullInfoArray.push(msg)
		}
		this.loadingModal.close()
		const pulled = new PulledModal(this.app,this.pullInfoArray)
		pulled.open()
	}

	// 创建文件和文件夹
	async createFilesAndFolders(data: any, basePath: string,) {
		for (const doc of data) {
			const cleanBasePath = basePath.replace(/^\//, '');
			const docPath = cleanBasePath ? `${cleanBasePath}/${doc.name}` : doc.name;
			const docIndexPath = cleanBasePath ? `${cleanBasePath}/${doc.name}/${doc.name}_index` : doc.name;
			if (doc.sub.length === 0) {// 如果 sub 为空，文档不包含子文档，创建文件
				await this.createFile(docPath,doc);
			} else {// 如果 sub 不为空，文档包含子文档，创建文件夹、文件并递归处理 sub
				await this.createFolder(docPath, doc.id, doc.create_user || '', doc.status); // 创建同名文件夹
				await this.createFilesAndFolders(doc.sub, docPath); // 递归子文档
			}
		}
	}

	// 获取文档内容并创建valut文件
	async createFile(docPath:string,doc:any){
		// console.log(docPath)
		let data = {did:doc.id}
		let docContent = await this.req.getDoc(data)
		if(!docContent.status){
			new Notice(`【拉取失败】文档：${doc.name}`);
			return
		};
		
		const filePath = normalizePath(`${docPath}.md`) // 清理文件路径
		const fileExits = this.app.vault.getAbstractFileByPath(filePath) // 获取本地文件是否存在，其可能是文件也可能是文件夹
		const mapExits = this.settings.fileMap.find(item => item.doc_id === doc.id) // 获取文档映射是否存在
		const mapFileExits = (mapExits && mapExits.path) ? this.app.vault.getAbstractFileByPath(mapExits.path) : false; // 获取文档映射的本地文件是否存在

		if(!mapExits && !fileExits){ // 既不存在文档映射，也不存在本地同名文件，直接新建文件
			const file = await this.app.vault.create(filePath,docContent.data.md_content)
			this.settings.fileMap.push({
				path: file.path,
				doc_id: doc.id,
				creator: doc.create_user || '',
				status: doc.status !== undefined ? doc.status : (docContent.data.status !== undefined ? docContent.data.status : 1),
				modify_time: docContent.data.modify_time ? String(docContent.data.modify_time) : undefined,
			});
			this.saveSettings()
			let msg = `【已创建】文件：${doc.name}`
			new Notice(msg)
			this.pullInfoArray.push(msg)
		}else if(mapExits){ // 如果存在文档映射
			// 同步服务端状态到本地映射
			mapExits.status = doc.status !== undefined ? doc.status : (docContent.data.status !== undefined ? docContent.data.status : mapExits.status);
			mapExits.modify_time = docContent.data.modify_time ? String(docContent.data.modify_time) : mapExits.modify_time;

			if(fileExits && mapFileExits && fileExits.path != mapFileExits.path){ // 存在本地文件和映射文件，且两者不一致
				mapExits.path = filePath;
				this.saveSettings()
				await this.compareFileModified(fileExits,docContent)
			}else if(fileExits && mapFileExits && fileExits.path === mapFileExits.path){ // 存在本地文件和映射文件，且两者一致
				await this.compareFileModified(fileExits,docContent)
			}else if(mapFileExits && !fileExits){ // 存在映射文件，不存在本地文件
				const renameFile = await this.app.vault.rename(mapFileExits,filePath)
				mapExits.path = filePath;
				this.saveSettings()
				await this.compareFileModified(mapFileExits,docContent)
			}else if(fileExits && !mapFileExits){ // 存在本地文件，不存在映射文件
				mapExits.path = filePath;
				this.saveSettings()
				await this.compareFileModified(fileExits,docContent)
			}else{
				let msg = `【已存在】文件：${doc.name}`
				new Notice(msg)
				this.pullInfoArray.push(msg)
			}
		}else{
			let msg = `【已存在】文件：${doc.name}`
			new Notice(msg)
			this.pullInfoArray.push(msg)
		}
	}

	// 对比文件最后修改时间判断是否需要更新内容
	private async compareFileModified(file:TFile | TAbstractFile | TFolder,doc:any){
		const fileType = this.isFileOrFolder(file)
		if (fileType == 'file') {
			const localModified = new Date(file.stat.mtime);
			const mrdocModified = new Date(doc.data.modify_time);
			// console.log(file.stat.mtime,doc.data.modify_time)
			// console.log(localModified,mrdocModified)
			if (localModified.getTime() < mrdocModified.getTime()) {
				// console.log("本地文件比远程文件旧");
				const modify = await this.app.vault.modify(file,doc.data.md_content)
				let msg = `【已更新】文件：${doc.data.name}`
				new Notice(msg)
				this.pullInfoArray.push(msg)
			}else{
				let msg = `【无需更新】文件：${doc.data.name}`
				new Notice(msg)
				this.pullInfoArray.push(msg)
			}
		} else {

		}
		
	}

	// 创建文件夹
	private async createFolder(docPath: string, docId: string | number, docCreator: string = '', docStatus?: number){
		const fileExits = this.app.vault.getAbstractFileByPath(`${docPath}`)
		if(fileExits){
			// 更新已有映射的 status
			const existingMap = this.settings.fileMap.find(item => item.path === docPath);
			if(existingMap && docStatus !== undefined){
				existingMap.status = docStatus;
				this.saveSettings();
			}
			new Notice(`【已存在】文件夹：${docPath}`)
		}else{
			const file = await this.app.vault.createFolder(`${docPath}`)
			this.settings.fileMap.push({
				path: file.path,
				doc_id: docId,
				creator: docCreator,
				status: docStatus !== undefined ? docStatus : 1,
			});
			this.saveSettings()
			new Notice(`【已创建】文件夹：${docPath}`)
		}
	}

	async toCreate(file: TFile | TFolder, isManual: boolean = false){
		const fileType = this.isFileOrFolder(file)
		switch(fileType){
			case "file":
				let fileExt = file.extension;
				if(fileExt == 'md'){
					await this.handleMarkdown(file, isManual)
				}else if (fileExt == 'html'){
					await this.handleHTML(file, isManual)
				}
				break;
			case "folder":
				await this.handleFolder(file, isManual)
		}
	}

	async toModify(file: TFile | TFolder){
		const found = this.settings.fileMap.find(item => item.path === file.path);
		if(!found) return;

		// 冲突检测：对比本地缓存的 modify_time 与服务端当前值
		if(found.modify_time){
			try {
				const serverDoc = await this.req.getDoc({ did: found.doc_id });
				if(serverDoc.status && serverDoc.data.modify_time){
					const localTime = found.modify_time;
					const serverTime = String(serverDoc.data.modify_time);
					if(!this.isModifyTimeEqual(localTime, serverTime)){
						return new Promise<void>((resolve) => {
							new SyncConfirmModal(this.app, {
								title: '文档冲突提醒',
								message: `「${file.name}」在 MrDoc 上已被修改（${serverTime}），本地缓存时间为（${localTime}），强制推送将覆盖服务端内容。`,
								warning: 'MrDoc 保留有历史版本，可在服务端恢复。',
								confirmText: '强制推送',
								cancelText: '取消',
								onConfirm: async () => {
									await this.doModify(file);
									resolve();
								},
								onCancel: () => {
									new Notice('已取消推送');
									resolve();
								}
							}).open();
						});
					}
				}
			} catch(e) {
				console.warn("冲突检测查询失败，继续推送:", e);
			}
		}

		await this.doModify(file);
	}

	/**
	 * 比较两个 modify_time 是否表示同一时刻。
	 * 服务端返回的时间格式可能不一致（"2026-03-06 17:32:02.150985" vs "2026-03-06T17:32:02.150"），
	 * 先尝试解析为时间戳，容忍 2 秒以内的误差视为相同。
	 */
	private isModifyTimeEqual(localTime: string, serverTime: string): boolean {
		if(localTime === serverTime) return true;
		try {
			const localMs = new Date(localTime.replace(' ', 'T')).getTime();
			const serverMs = new Date(serverTime.replace(' ', 'T')).getTime();
			if(isNaN(localMs) || isNaN(serverMs)) return false;
			return Math.abs(localMs - serverMs) < 2000;
		} catch {
			return false;
		}
	}

	private async doModify(file: TFile | TFolder){
		const fileType = this.isFileOrFolder(file)
		switch(fileType){
			case 'file':
				await this.handleModifyFile(file);
				break;
			case 'folder':
				await this.handleModifyFolder(file);
				break;
		}
	}

	// 手动保存内容到MrDoc
	async onSave(){
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			// const filePath = activeFile.path;
			// console.log(`当前编辑文件路径: ${filePath}`);
			await this.onSyncItem(activeFile)
		}
	}

	// 响应「同步」按钮的点击（手动触发）
	async onSyncItem(file: TFile | TFolder){
		let found = this.settings.fileMap.find(item => item.path === file.path)
		if(found){
			this.toModify(file)
		}else{
			this.toCreate(file, true)
		}
	}

	// 响应「从 MrDoc 拉取」按钮的点击
	async onPullItem(file: TFile | TFolder){
		const found = this.settings.fileMap.find(item => item.path === file.path);
		if(!found){
			new Notice("该文件未与 MrDoc 建立映射，无法拉取");
			return;
		}
		const fileType = this.isFileOrFolder(file);
		if(fileType === 'folder'){
			new Notice("文件夹请使用左侧栏的全量拉取功能");
			return;
		}
		const doc = {did: found.doc_id};
		const res = await this.req.getDoc(doc);
		if(res.status){
			this.settings.pulling = true;
			await this.saveSettings();
			await this.app.vault.modify(file, res.data.md_content);
			found.modify_time = res.data.modify_time ? String(res.data.modify_time) : undefined;
			found.status = res.data.status !== undefined ? res.data.status : found.status;
			this.settings.pulling = false;
			await this.saveSettings();
			new Notice("已从 MrDoc 拉取更新：" + file.name);
		}else{
			new Notice("从 MrDoc 拉取失败：" + res.data);
		}
	}

	// 响应「发布文档 / 转为草稿」按钮的点击
	async onToggleDocStatus(file: TFile | TFolder, found: FileMapEntry){
		const isDraft = found.status === 0;
		const action = isDraft ? 'publish' : 'draft';
		const actionLabel = isDraft ? '发布' : '转为草稿';
		const res = await this.req.toggleDocStatus({ did: found.doc_id, action });
		if(res.status){
			found.status = res.doc_status !== undefined ? res.doc_status : (isDraft ? 1 : 0);
			if(res.modify_time){
				found.modify_time = String(res.modify_time);
			}
			await this.saveSettings();
			new Notice(`文档已${actionLabel}：${file.name}`);
		}else{
			new Notice(`文档${actionLabel}失败：${res.data || '未知错误'}`);
		}
	}

	// 判断文档是否为他人创建
	private isOtherUserDoc(found: { creator?: string }): boolean {
		if (!found.creator || !this.settings.currentUser) return false;
		return found.creator !== this.settings.currentUser;
	}

	// 侦听文档的创建（自动事件触发，非手动）
	async onVaultCreate(file: TFile | TFolder) {
		if(this.settings.pulling) return;
		if(this.settings.pushing) return;
		if(this.settings.syncMode === 'manual') return;
		this.toCreate(file, false)
	}

	// 侦听文档的修改
	async onVaultModify(file: TFile | TFolder) {
		if(this.settings.pulling) return;
		if(this.settings.pushing) return;
		if(this.settings.syncMode === 'manual') return;

		if(this.settings.syncMode === 'collaborative') {
			const found = this.settings.fileMap.find(item => item.path === file.path);
			if(found && this.isOtherUserDoc(found)) {
				new SyncConfirmModal(this.app, {
					title: '确认修改他人文档',
					message: `「${file.name}」由 ${found.creator} 创建，是否同步修改到 MrDoc？`,
					warning: '此操作将覆盖 MrDoc 上的文档内容。',
					confirmText: '确认同步',
					cancelText: '取消',
					onConfirm: () => this.toModify(file),
					onCancel: () => {}
				}).open();
				return;
			}
		}

		this.toModify(file)
	}

	// 侦听文档的重命名（仅更新本地映射路径，不自动同步层级到服务端）
	async onVaultRename(file: TFile | TFolder, oldPath: string) {
		if(this.settings.pulling) return;
		if(this.settings.pushing) return;
		let found = this.settings.fileMap.find(item => item.path === oldPath);
		if(!found) return;

		found.path = file.path;
		this.saveSettings();
	}

	// 侦听文档的删除
	async onVaultDelete(file: TFile | TFolder) {
		if(this.settings.pulling) return;
		if(this.settings.pushing) return;

		let found = this.settings.fileMap.find(item => item.path === file.path);
		if(!found) return;

		const doc_id = found.doc_id;
		const isOther = this.isOtherUserDoc(found);

		const removeMapping = () => {
			this.settings.fileMap = this.settings.fileMap.filter(
				item => item.path !== file.path
			);
			this.saveSettings();
		};

		const syncDelete = async () => {
			const res = await this.req.delDoc({ did: doc_id });
			if(res.status) {
				new Notice("文档已同步删除！");
			} else {
				new Notice("文档同步删除失败，请前往 MrDoc 自行删除！");
			}
		};

		switch(this.settings.syncMode) {
			case 'manual':
				removeMapping();
				new Notice("已移除本地映射，MrDoc 文档保留不变");
				break;

			case 'collaborative':
				new SyncConfirmModal(this.app, {
					title: isOther ? '确认删除他人文档' : '确认同步删除',
					message: isOther
						? `「${file.name}」由 ${found.creator} 创建，是否从 MrDoc 删除？`
						: `确认将「${file.name}」从 MrDoc 移至回收站？`,
					warning: isOther
						? '删除后团队所有成员均无法访问此文档！'
						: 'MrDoc 文档将被移至回收站。',
					confirmText: '同步删除',
					cancelText: '仅删除本地',
					onConfirm: async () => { removeMapping(); await syncDelete(); },
					onCancel: () => {
						removeMapping();
						new Notice("已移除本地映射，MrDoc 文档保留不变");
					}
				}).open();
				break;

			case 'auto':
			default:
				removeMapping();
				await syncDelete();
				break;
		}
	}

	/**
	 * 上传本地图片并返回远程 URL
	 */
	async uploadLocalImage(file: TFile): Promise<string | null> {
		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
  			const imgBlob = new Blob([arrayBuffer]);		 
			const imgData = {
				'base64':await imgFileToBase64(imgBlob)
			};
			const resp = await this.req.uploadImage(imgData)

			if (resp.success === 1) {
				const mrdocUrl = processMrdocUrl(this.settings.mrdocUrl);
				return resp.url.startsWith('http') ? resp.url : `${mrdocUrl}${resp.url}`;
			} else {
				console.warn("图片上传失败:", resp);
				return null;
			}
		} catch (e) {
			console.error("图片上传异常:", e);
			return null;
		}
	}
	
	/**
	 * 上传本地附件并返回远程 URL
	 */
	async uploadLocalAttachment(file: TFile): Promise<string | null> {
		try {
			const name = file.name;
			const arrayBuffer = await this.app.vault.readBinary(file);
			const resp = await this.req.uploadAttachment(arrayBuffer, name);
		
			if (resp.status) {
				const mrdocUrl = processMrdocUrl(this.settings.mrdocUrl);
				if (resp.data.url) {
				return resp.data.url.startsWith("attachment")
					? `${mrdocUrl}/media/${resp.data.url}`
					: resp.data.url;
				}
			} else {
				console.warn("附件上传失败:", resp);
			}
			return null;
		} catch (e) {
			console.error("附件上传异常:", e);
			return null;
		}
	}

	// 编辑器粘贴事件
	async onEditorPaste(evt: ClipboardEvent,editor: Editor, view: MarkdownView){
		// console.log("编辑器粘贴事件")
        // // 获取粘贴板的数据
        const clipboardData = evt.clipboardData;
        // console.log("粘贴板类型：",clipboardData?.types)

		if (clipboardData.types.includes('text/html') || clipboardData.types.includes('text/plain')) {
			if(!this.settings.applyImage) return;

			const clipboardValue = clipboardData.types.includes('text/html') ? clipboardData.getData("text/html") : clipboardData.getData("text/plain");
			const imageList = clipboardData.types.includes('text/html')
			  ? this.helper.getHtmlImageLink(clipboardValue)
					.filter(image => image.path.startsWith("http"))
					.filter(
					  image =>
						!this.helper.hasWhitelistedDomain(image.path, this.settings.assetWhitelist)
					)
			  : this.helper.getImageLink(clipboardValue)
					.filter(image => image.path.startsWith("http"))
					.filter(
					  image =>
						!this.helper.hasWhitelistedDomain(image.path, this.settings.assetWhitelist)
					);
			
			if (imageList.length === 0) return;
			// console.log("粘贴板图片列表：",imageList)
			new Notice("外链图片转存中……")
			this.req.uploadUrlImageBatch(imageList.map(img => img))
			.then(res => {
				let value = this.helper.getValue();
				res.map(item =>{
					if(!item.success) return;
					let mrdocUrl = processMrdocUrl(this.settings.mrdocUrl)
					if(item.originalFile.title == ""){
						value = value.replaceAll(
							`![${item.originalFile.alt}](${item.originalURL})`,
							`![${item.originalFile.alt}](${mrdocUrl}${item.url})`
							);
					}else{
						value = value.replaceAll(
							`![${item.originalFile.alt}](${item.originalURL} "${item.originalFile.title}")`,
							`![${item.originalFile.alt}](${mrdocUrl}${item.url} "${item.originalFile.title}")`
							);
					}
				});
				this.helper.setValue(value);
				new Notice("外链图片转存完成！")
			})

		}else if (clipboardData.types.includes('Files')) {
			if(!this.settings.saveImg) return;
			evt.preventDefault();
            const files = clipboardData.files;
			if (files.length === 0) return;
			for (const file of files) {
				if (file.type.startsWith('image/')) {
					// console.log('粘贴的图片:', file);
					let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
					this.insertTemporaryText(editor, pasteId);
					const name = file.name;
					const imgData = {
						'base64':await imgFileToBase64(file)
					};
					const resp = await this.req.uploadImage(imgData)
					// console.log(resp)
					if(resp.success == 1){
						let imgUrl;
						if(resp.url.startsWith('http')){
							imgUrl = resp.url;
						}else{
							let mrdocUrl = processMrdocUrl(this.settings.mrdocUrl)
							imgUrl = `${mrdocUrl}${resp.url}`
						}
						this.embedMarkDownImage(editor, pasteId, imgUrl, name);
					}else{
						new Notice("粘贴图片上传失败")
					}
				}
			}
        }
		
	}

	// 编辑器拖拽事件
	async onEditorDrop(evt:DragEvent, editor:Editor,markdownView: MarkdownView){
		if(!this.settings.saveImg) return;

		let files = evt.dataTransfer.files;
		console.log(files[0].type)
		if(files.length == 0)return;
		if (files[0].type.startsWith("image")) { // 图片上传
            let sendFiles: Array<string> = [];
            let files = evt.dataTransfer.files;
            Array.from(files).forEach((item, index) => {
              sendFiles.push(item.path);
            });
            evt.preventDefault();

			for (const file of files) {
				// console.log('拖入的图片:', file);
				let pasteId = (Math.random() + 1).toString(36).substr(2, 5);
				this.insertTemporaryText(editor, pasteId);
				const name = file.name;
				const imgData = {
					'base64':await imgFileToBase64(file)
				};
				const resp = await this.req.uploadImage(imgData)
				// console.log(resp)
				if(resp.success == 1){
					let mrdocUrl = processMrdocUrl(this.settings.mrdocUrl)
					let imgUrl = ""
					if(resp.url.startsWith('http')){
						imgUrl = resp.url;
					}else{
						imgUrl = `${mrdocUrl}${resp.url}`
					}
					this.embedMarkDownImage(editor, pasteId, imgUrl, name);
				}else{
					new Notice("拖入图片上传失败")
				}
			}
        }else{ // 附件上传
			evt.preventDefault();
			for (const file of files) {
				let pasteId = (Math.random() + 1).toString(36).substr(2, 5); 
				this.insertTemporaryText(editor, pasteId);
				const name = file.name;
				
				try {
				  // 读取文件数据
				  const arrayBuffer = await file.arrayBuffer();
				  
				  // 调用上传附件 API
				  const resp = await this.req.uploadAttachment(arrayBuffer, name);
				  
				  if(resp.status) {
					// 获取附件URL
					let mrdocUrl = processMrdocUrl(this.settings.mrdocUrl);
					let attachmentUrl = '';
					if(resp.data.url && resp.data.url.startsWith('attachment')) {
						attachmentUrl = `${mrdocUrl}/media/${resp.data.url}`;
					  } else {
						attachmentUrl = resp.data.url;
					  }
					
					// 创建Markdown链接文本并替换临时文本
					let markDownLink = `[${name}](${attachmentUrl})`;
					let progressText = MrdocPlugin.progressTextFor(pasteId);
					MrdocPlugin.replaceFirstOccurrence(editor, progressText, markDownLink);
				  } else {
					new Notice("拖入附件上传失败: " + resp.data);
					// 清除临时文本
					let progressText = MrdocPlugin.progressTextFor(pasteId);
					MrdocPlugin.replaceFirstOccurrence(editor, progressText, "");
				  }
				} catch (error) {
				  console.error("附件上传处理错误:", error);
				  new Notice("附件上传处理失败");
				  // 清除临时文本
				  let progressText = MrdocPlugin.progressTextFor(pasteId);
				  MrdocPlugin.replaceFirstOccurrence(editor, progressText, "");
				}
			  }
		}
	}

	// 解析文件的上级
	async getFileParent(file: TFile | TFolder){
		if(file.parent.parent === null){ // 没有上级
			return 0
		}

		const parentPathSegments = [];
		let currentFolder = file.parent;

		// 逐层向上访问 parent 属性，直到根目录
		while (currentFolder) {
			if(currentFolder.name !== ''){
				parentPathSegments.unshift(currentFolder.name);
			}
			currentFolder = currentFolder.parent;
		}

		// 拼接上级路径
		const parentPath = parentPathSegments.join("/");
		// console.log("上级路径：",parentPathSegments,parentPath)
		let found = this.settings.fileMap.find(item => item.path === parentPath)
		if (found){
			return found.doc_id
		} else {
			return 0
		}
	}

	/**
	 * 转存 Vault 文档中的图片/附件到 MrDoc
	 *
	 * 功能：
	 * 1. 扫描 Markdown 内容中的图片/附件链接（![[xxx]] 或 ![](xxx)）
	 * 2. 判断是否在白名单域名中，如果在则跳过转存
	 * 3. 如果是本地图片，则上传到 MrDoc 并替换为远程链接
	 * 4. 如果是其他附件，则上传并替换为远程链接
	 */
	async processAssets(content: string, file: TFile): Promise<string> {
		const app = this.app;
		const vault = app.vault;
		const folder = file.parent.path;
		const regex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/g; // 匹配 ![[xxx]] 和 ![](xxx)
	  
		let matches;
		while ((matches = regex.exec(content)) !== null) {
		  const rawLink = matches[1] || matches[2];
		  if (!rawLink) continue;
	  
		  // 域名白名单判断
		  const isWhitelisted = this.settings.assetWhitelist?.some(domain =>
			rawLink.includes(domain)
		  );
		  if (isWhitelisted) {
			console.log(`跳过转存（白名单命中）：${rawLink}`);
			continue; // 不做任何替换
		  }

		  const linkedFile = app.metadataCache.getFirstLinkpathDest(rawLink, folder);
		  if (!linkedFile) continue;
	  
		  const ext = linkedFile.extension.toLowerCase();
		  const name = linkedFile.name;
		  let remoteUrl = '';
	  
		  try {
			if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
				// console.log(linkedFile)
				let imgUrl = await this.uploadLocalImage(linkedFile)
			  if (imgUrl) {
				content = content.replace(matches[0], `![](${imgUrl})`);
			  } else {
				console.warn(`图片上传失败: ${name}`);
			  }
			} else {
			  const arrayBuffer = await vault.readBinary(linkedFile);
			  const resp = await this.req.uploadAttachment(arrayBuffer, name);
	  
			  if (resp.status) {
				const mrdocUrl = processMrdocUrl(this.settings.mrdocUrl);
				if (resp.data.url) {
				  remoteUrl = resp.data.url.startsWith('attachment')
					? `${mrdocUrl}/media/${resp.data.url}`
					: resp.data.url;
	  
				  const markdownLink = `[${name}](${remoteUrl})`;
				  content = content.replace(matches[0], markdownLink);
				}
			  } else {
				console.warn(`附件上传失败: ${name}`);
			  }
			}
		  } catch (e) {
			console.error(`上传失败: ${rawLink}`, e);
		  }
		}
	  
		return content;
	  }
	  

	// 获取文件类型
	getMimeType(ext: string): string {
		const map: Record<string, string> = {
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			gif: 'image/gif',
			webp: 'image/webp',
			svg: 'image/svg+xml',
		};
		return map[ext] || 'application/octet-stream';
	}

	// 创建 Markdown 文件文档
	async handleMarkdown(file: TFile, isManual: boolean = false) {
		let oldContent = await this.app.vault.cachedRead(file);
    	let newContent = oldContent;
		let parentValue = await this.getFileParent(file);

		// 处理资源链接
		if (this.settings.saveImg) {
			newContent = await this.processAssets(oldContent, file);
	
			// 只有在内容确实发生变化时才写回
			if (oldContent !== newContent) {
				await this.app.vault.modify(file, newContent);
			}
		}

		let doc: any = {
		  pid: this.settings.defaultProject,
		  title: file.basename,
		  editor_mode: 1,
		  doc: newContent,
		  parent_doc: parentValue,
		  status: isManual ? 1 : 0,
		};
		return this.handleDocument(file, doc);
	  }
	
	  // 创建 HTML 文件文档
	  async handleHTML(file: TFile, isManual: boolean = false) {
		let content = await this.app.vault.cachedRead(file)
		let parentValue = await this.getFileParent(file);
		let doc: any = {
		  pid: this.settings.defaultProject,
		  title: file.basename,
		  editor_mode: 3,
		  doc: content,
		  parent_doc: parentValue,
		  status: isManual ? 1 : 0,
		};
		return this.handleDocument(file, doc);
	  }

	  // 创建文件夹文档
	async handleFolder(file:TFile | TFolder, isManual: boolean = false) {
		let parentValue = await this.getFileParent(file);
		let doc: any = {
		  pid: this.settings.defaultProject,
		  title: file.name,
		  editor_mode: 1,
		  doc: '',
		  parent_doc: parentValue,
		  status: isManual ? 1 : 0,
		};
		return this.handleDocument(file, doc);
	  }
	
	  // 创建文档
	  async handleDocument(file: TFile | TFolder, doc: any) {
		const res = await this.req.createDoc(doc);
		if (res.status) {
		  const docStatus = doc.status !== undefined ? doc.status : 1;
		  this.settings.fileMap.push({
			path: file.path,
			doc_id: res.data,
			creator: this.settings.currentUser,
			status: docStatus,
			modify_time: res.modify_time ? String(res.modify_time) : undefined,
		  });
		  this.saveSettings();
		  const statusLabel = docStatus === 0 ? '（草稿）' : '';
		  new Notice("文档" + doc.title + "已同步至MrDoc！" + statusLabel);
		} else {
		  new Notice("文档同步至MrDoc失败！");
		}
	  }

	  //  修改文件
	  async handleModifyFile(file: TFile){
		// console.log(file)
		// 判断是否存在映射
		let found = this.settings.fileMap.find(item => item.path === file.path)
		if(found){
			// 读取原始内容
			let oldContent = await this.app.vault.cachedRead(file);
			let newContent = oldContent;

			// 如果开启了图片保存，则处理资源链接
			if(this.settings.saveImg){
				newContent = await this.processAssets(oldContent, file);
			}

			// 只有在内容确实发生变化时才写回
			if (oldContent !== newContent) {
				await this.app.vault.modify(file, newContent);
			}

			let parentValue = await this.getFileParent(file);
			// console.log(content)
			let doc = {
				pid:this.settings.defaultProject,
				did:found.doc_id,
				title:file.basename,
				doc:newContent,
				parent_doc: parentValue,
			}
			return this.handleModify(doc)
		}
	  }

	  // 修改文件夹
	  async handleModifyFolder(file: TFile | TFolder){
		// 判断是否存在映射
		let found = this.settings.fileMap.find(item => item.path === file.path)
		if(found){
			let parentValue = await this.getFileParent(file);
			let doc = {
				pid:this.settings.defaultProject,
				did:found.doc_id,
				title:file.name,
				doc:'',
				parent_doc: parentValue,
			}
			return this.handleModify(doc)
		}
	  }

	  // 处理修改操作
	  async handleModify(doc:any){
		const res = await this.req.modifyDoc(doc)
		if(res.status){
			// 更新 fileMap 中的 modify_time
			if(res.modify_time){
				const found = this.settings.fileMap.find(item => item.doc_id === doc.did);
				if(found){
					found.modify_time = String(res.modify_time);
					await this.saveSettings();
				}
			}
			let formattedTime = this.formatCurrentTime()
			this.statusBar.setText(`同步于：${formattedTime}`)
			if(this.settings.syncMode === 'manual'){
				new Notice("文档已同步至 MrDoc")
			}
		}else{
			new Notice("文档同步至MrDoc失败！")
		}
	  }
	  
	// 判断文件类型
	isFileOrFolder(file: TAbstractFile): "file" | "folder" | "unknown" {
		if (file instanceof TFile) {
			return "file";
		} else if (file instanceof TFolder) {
			return "folder";
		} else {
			return "unknown";
		}
	}

	  // 格式化当前时间
	  formatCurrentTime(){
		const currentDate = new Date();
		const f_time = `${currentDate.getHours().toString().padStart(2, '0')}:${currentDate.getMinutes().toString().padStart(2, '0')}:${currentDate.getSeconds().toString().padStart(2, '0')}`;
		return f_time
	}

	// 【图片】上传插入临时文本
	insertTemporaryText(editor: Editor, pasteId: string) {
		let progressText = MrdocPlugin.progressTextFor(pasteId);
		editor.replaceSelection(progressText + "\n");
	  }
	
	//   【图片】上传进度文本
	private static progressTextFor(id: string) {
		return `![Uploading file...${id}]()`;
	}

	embedMarkDownImage(
		editor: Editor,
		pasteId: string,
		imageUrl: any,
		name: string = ""
	  ) {
		let progressText = MrdocPlugin.progressTextFor(pasteId);
		// name = this.handleName(name);
	
		let markDownImage = `![${name}](${imageUrl})`;
	
		MrdocPlugin.replaceFirstOccurrence(
		  editor,
		  progressText,
		  markDownImage
		);
	  }

	static replaceFirstOccurrence(
		editor: Editor,
		target: string,
		replacement: string
	  ) {
		let lines = editor.getValue().split("\n");
		for (let i = 0; i < lines.length; i++) {
		  let ch = lines[i].indexOf(target);
		  if (ch != -1) {
			let from = { line: i, ch: ch };
			let to = { line: i, ch: ch + target.length };
			editor.replaceRange(replacement, from, to);
			break;
		  }
		}
	  }
	

	// 显示拉取模态框
    private async showPullModal() {
		if (!this.loadingModal) {
			this.loadingModal = new LoadingModal(this.app);
		}
		const modal = new PullMrdocModal(this.app, () => {
			// 在这里写模态框内部的逻辑
			this.pullMrDoc()
			this.loadingModal!.open()
		});
		modal.open();
    }

	// ======================================================================
	// 推送本地文档到 MrDoc（批量）
	// ======================================================================

	// 显示推送确认模态框
	private async showPushModal() {
		if (!this.settings.mrdocUrl || !this.settings.mrdocToken) {
			new Notice("请先在设置中填写 MrDoc URL 与用户 Token");
			return;
		}
		if (!this.settings.defaultProject) {
			new Notice("请先在设置中选择一个目标文集");
			return;
		}

		const modal = new PushMrdocModal(this.app, async (options) => {
			await this.pushMrDoc(options);
		});
		modal.open();
	}

	// 推送本地 Vault 中的全部文档（按所选模式过滤）
	async pushMrDoc(options: PushOptions): Promise<void> {
		// 收集所有可推送的节点（深度优先：父先于子）
		const nodes = this.collectPushableNodes();

		const stats: PushStats = {
			total: nodes.length,
			processed: 0,
			created: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
		};
		const details: PushedDetail[] = [];

		if (stats.total === 0) {
			new Notice("当前 Vault 没有可推送的文档（仅支持 .md / .html 文件与文件夹）");
			return;
		}

		// 打开进度模态框
		const progressModal = new PushProgressModal(this.app);
		progressModal.open();
		progressModal.updateStats(stats);

		// 标记推送中：避免事件回环
		this.settings.pushing = true;
		await this.saveSettings();

		try {
			for (const node of nodes) {
				progressModal.setCurrent(`正在处理：${this.describeNode(node)}`);

				let result: PushItemResult;
				try {
					result = await this.batchPushNode(node, options);
				} catch (e: any) {
					console.error("批量推送节点异常：", node.path, e);
					result = {
						level: 'failed',
						action: 'failed',
						message: `【异常】${this.describeNode(node)}：${e?.message || e}`,
					};
				}

				stats.processed += 1;
				switch (result.action) {
					case 'created':
						stats.created += 1;
						break;
					case 'updated':
						stats.updated += 1;
						break;
					case 'skipped':
						stats.skipped += 1;
						break;
					case 'failed':
						stats.failed += 1;
						break;
				}

				details.push({ level: result.level, text: result.message });
				progressModal.appendLog(result.message);
				progressModal.updateStats(stats);
			}
		} finally {
			this.settings.pushing = false;
			await this.saveSettings();

			progressModal.setHeader("推送已完成");
			progressModal.setCurrent("即将展示结果汇总…");
			// 短暂停留以便用户看到最终统计
			await new Promise((resolve) => window.setTimeout(resolve, 300));
			progressModal.close();
		}

		// 展示结果
		const pushedModal = new PushedModal(this.app, details, stats);
		pushedModal.open();

		// 顶部状态栏显示同步时间
		if (this.statusBar) {
			this.statusBar.setText(`推送于：${this.formatCurrentTime()}`);
		}
	}

	// 收集 Vault 中所有可推送的节点（文件夹 + .md/.html 文件），按父先子后顺序返回
	private collectPushableNodes(): Array<TFile | TFolder> {
		const result: Array<TFile | TFolder> = [];
		const root = this.app.vault.getRoot();
		this.collectChildrenRecursive(root, result);
		return result;
	}

	private collectChildrenRecursive(folder: TFolder, result: Array<TFile | TFolder>): void {
		// 先处理子文件夹（父优先入列）
		const subFolders: TFolder[] = [];
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				subFolders.push(child);
			} else if (child instanceof TFile) {
				const ext = child.extension.toLowerCase();
				if (ext === 'md' || ext === 'html') {
					files.push(child);
				}
			}
		}

		// 当前层级的文件夹先入列，并立即递归其子节点
		for (const sub of subFolders) {
			result.push(sub);
			this.collectChildrenRecursive(sub, result);
		}

		// 该层级的文件最后入列（确保所有可能的父文件夹已先入列处理）
		for (const file of files) {
			result.push(file);
		}
	}

	// 描述一个节点（用于日志/UI）
	private describeNode(node: TFile | TFolder): string {
		if (node instanceof TFolder) {
			return `文件夹「${node.path}」`;
		}
		return `文档「${node.path}」`;
	}

	// 单节点批量推送：根据映射状态与模式决定创建/更新/跳过
	private async batchPushNode(node: TFile | TFolder, options: PushOptions): Promise<PushItemResult> {
		const found = this.settings.fileMap.find((m) => m.path === node.path);

		if (found) {
			// 已映射
			if (options.mode === 'create-only') {
				return {
					level: 'skipped',
					action: 'skipped',
					message: `【跳过】${this.describeNode(node)}：已映射，按模式跳过`,
				};
			}
			// full / update-only
			if (node instanceof TFolder) {
				return await this.batchUpdateFolder(node, found);
			}
			return await this.batchUpdateFile(node, found);
		}

		// 未映射
		if (options.mode === 'update-only') {
			return {
				level: 'skipped',
				action: 'skipped',
				message: `【跳过】${this.describeNode(node)}：未映射，按模式跳过`,
			};
		}
		// full / create-only
		if (node instanceof TFolder) {
			return await this.batchCreateFolder(node, options);
		}
		return await this.batchCreateFile(node, options);
	}

	// 批量创建：文件
	private async batchCreateFile(file: TFile, options: PushOptions): Promise<PushItemResult> {
		const ext = file.extension.toLowerCase();

		// 读取并处理内容（按现有规则只对 md 转存资源）
		let oldContent = await this.app.vault.cachedRead(file);
		let newContent = oldContent;
		if (ext === 'md' && this.settings.saveImg) {
			try {
				newContent = await this.processAssets(oldContent, file);
				if (oldContent !== newContent) {
					await this.app.vault.modify(file, newContent);
				}
			} catch (e) {
				console.warn("批量创建：资源转存失败，将以原始内容继续推送：", file.path, e);
				newContent = oldContent;
			}
		}

		const parentValue = await this.getFileParent(file);
		const editorMode = ext === 'html' ? 3 : 1;
		const status = options.includeDrafts ? 0 : 1;

		const doc: any = {
			pid: this.settings.defaultProject,
			title: file.basename,
			editor_mode: editorMode,
			doc: ext === 'html' ? oldContent : newContent,
			parent_doc: parentValue,
			status,
		};

		const res = await this.req.createDoc(doc);
		if (res && res.status) {
			this.settings.fileMap.push({
				path: file.path,
				doc_id: res.data,
				creator: this.settings.currentUser,
				status,
				modify_time: res.modify_time ? String(res.modify_time) : undefined,
			});
			await this.saveSettings();
			const statusLabel = status === 0 ? '（草稿）' : '';
			return {
				level: 'success',
				action: 'created',
				message: `【已创建】${this.describeNode(file)}${statusLabel}`,
			};
		}

		return {
			level: 'failed',
			action: 'failed',
			message: `【创建失败】${this.describeNode(file)}：${res?.data || '未知错误'}`,
		};
	}

	// 批量创建：文件夹
	private async batchCreateFolder(folder: TFolder, options: PushOptions): Promise<PushItemResult> {
		const parentValue = await this.getFileParent(folder);
		const status = options.includeDrafts ? 0 : 1;

		const doc: any = {
			pid: this.settings.defaultProject,
			title: folder.name,
			editor_mode: 1,
			doc: '',
			parent_doc: parentValue,
			status,
		};

		const res = await this.req.createDoc(doc);
		if (res && res.status) {
			this.settings.fileMap.push({
				path: folder.path,
				doc_id: res.data,
				creator: this.settings.currentUser,
				status,
				modify_time: res.modify_time ? String(res.modify_time) : undefined,
			});
			await this.saveSettings();
			const statusLabel = status === 0 ? '（草稿）' : '';
			return {
				level: 'success',
				action: 'created',
				message: `【已创建】${this.describeNode(folder)}${statusLabel}`,
			};
		}

		return {
			level: 'failed',
			action: 'failed',
			message: `【创建失败】${this.describeNode(folder)}：${res?.data || '未知错误'}`,
		};
	}

	// 批量更新：文件（强制覆盖远程内容，跳过冲突检测）
	private async batchUpdateFile(file: TFile, found: FileMapEntry): Promise<PushItemResult> {
		const ext = file.extension.toLowerCase();

		let oldContent = await this.app.vault.cachedRead(file);
		let newContent = oldContent;
		if (ext === 'md' && this.settings.saveImg) {
			try {
				newContent = await this.processAssets(oldContent, file);
				if (oldContent !== newContent) {
					await this.app.vault.modify(file, newContent);
				}
			} catch (e) {
				console.warn("批量更新：资源转存失败，将以原始内容继续推送：", file.path, e);
				newContent = oldContent;
			}
		}

		const parentValue = await this.getFileParent(file);
		const doc: any = {
			pid: this.settings.defaultProject,
			did: found.doc_id,
			title: file.basename,
			doc: ext === 'html' ? oldContent : newContent,
			parent_doc: parentValue,
		};

		const res = await this.req.modifyDoc(doc);
		if (res && res.status) {
			if (res.modify_time) {
				found.modify_time = String(res.modify_time);
			}
			// 更新映射中的路径（容错：即便 path 没变也无影响）
			found.path = file.path;
			await this.saveSettings();
			return {
				level: 'success',
				action: 'updated',
				message: `【已更新】${this.describeNode(file)}`,
			};
		}

		return {
			level: 'failed',
			action: 'failed',
			message: `【更新失败】${this.describeNode(file)}：${res?.data || '未知错误'}`,
		};
	}

	// 批量更新：文件夹
	private async batchUpdateFolder(folder: TFolder, found: FileMapEntry): Promise<PushItemResult> {
		const parentValue = await this.getFileParent(folder);
		const doc: any = {
			pid: this.settings.defaultProject,
			did: found.doc_id,
			title: folder.name,
			doc: '',
			parent_doc: parentValue,
		};

		const res = await this.req.modifyDoc(doc);
		if (res && res.status) {
			if (res.modify_time) {
				found.modify_time = String(res.modify_time);
			}
			found.path = folder.path;
			await this.saveSettings();
			return {
				level: 'success',
				action: 'updated',
				message: `【已更新】${this.describeNode(folder)}`,
			};
		}

		return {
			level: 'failed',
			action: 'failed',
			message: `【更新失败】${this.describeNode(folder)}：${res?.data || '未知错误'}`,
		};
	}
}
