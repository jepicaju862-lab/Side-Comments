import { ItemView, WorkspaceLeaf, TFile, App, MarkdownView, Notice, ViewStateResult, Plugin, Setting, PluginSettingTab, MarkdownRenderer, setIcon, Component, normalizePath, Platform, Editor } from "obsidian";
import { Comment, CommentManager } from "./commentManager";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";

// --- Helper Functions ---

// Helper function to generate SHA256 hash
async function generateHash(text: string): Promise<string> {
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
        try {
            const nodeCrypto = require('crypto');
            return nodeCrypto.createHash('sha256').update(text).digest('hex');
        } catch {
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                const char = text.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        }
    }
}

async function generateBinaryHash(buffer: ArrayBuffer): Promise<string> {
    try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
        const nodeCrypto = require('crypto');
        return nodeCrypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    }
}

const forceUpdateEffect = StateEffect.define<null>();

interface CustomViewState extends Record<string, unknown> {
    filePath: string | null;
}

interface SideNoteSettings {
    commentSortOrder: "timestamp" | "position";
    showHighlights: boolean;
    markdownFolder: string;
    attachmentFolder: string;
    highlightColor: string;
    highlightOpacity: number;
    enableSelectionToolbar: boolean;
}

interface PluginData extends SideNoteSettings {
    comments: Comment[];
    imageHashes: Record<string, string>;
}

const DEFAULT_SETTINGS: SideNoteSettings = {
    commentSortOrder: "position",
    showHighlights: true,
    markdownFolder: "side-note-comments",
    attachmentFolder: "side-note-attachments",
    highlightColor: "#FFC800",
    highlightOpacity: 0.2,
    enableSelectionToolbar: true,
};

// --- View Class ---


class SideNoteView extends ItemView {
    private file: TFile | null = null;
    private plugin: SideNote;
    private activeCommentTimestamp: number | null = null;
    private searchQuery: string = "";
    // 新增：用于记录重绘前的滚动位置
    private lastScrollTop: number = 0;

    constructor(leaf: WorkspaceLeaf, plugin: SideNote, file: TFile | null = null) {
        super(leaf);
        this.plugin = plugin;
        this.file = file;
    }

    getViewType() { return "sidenote-view"; }
    getDisplayText() { return "Side Note"; }
    getIcon() { return "message-square"; }

    async onOpen() {
        await Promise.resolve();
        if (!this.file) {
            this.file = this.app.workspace.getActiveFile();
        }
        this.renderView();
    }

    async setState(state: CustomViewState, result: ViewStateResult): Promise<void> {
        if (state.filePath) {
            const file = this.app.vault.getAbstractFileByPath(state.filePath);
            if (file instanceof TFile) {
                this.file = file;
                this.renderView();
            }
        }
        await super.setState(state, result);
    }

    public updateActiveFile(file: TFile | null) {
        this.file = file;
        this.renderView();
    }

    public highlightComment(timestamp: number) {
        this.activeCommentTimestamp = timestamp;
        this.renderView();
        
        setTimeout(() => {
            const commentEl = this.containerEl.querySelector(`[data-comment-timestamp="${timestamp}"]`);
            if (commentEl) {
                // 修改点 1：改为 'nearest'，避免强制跳到中间
                commentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 100);
    }

    public renderView() {
        // 修改点 2：在清空前保存滚动位置
        const currentContainer = this.containerEl.querySelector(".sidenote-comments-list-wrapper");
        if (currentContainer) {
            this.lastScrollTop = currentContainer.scrollTop;
        }

        this.containerEl.empty();
        this.containerEl.addClass("sidenote-view-container");

        // Toolbar
        const toolbar = this.containerEl.createDiv("sidenote-toolbar");
        
        const searchInput = toolbar.createEl("input", {
            type: "text",
            placeholder: "Search comments..."
        });
        searchInput.value = this.searchQuery;
        
        searchInput.oninput = (e) => {
            const target = e.target as HTMLInputElement;
            this.searchQuery = target.value.toLowerCase();
            this.renderCommentsList(commentsContainer);
        };

        const exportBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        exportBtn.setAttribute("aria-label", "Export to Markdown");
        setIcon(exportBtn, "file-up");
        exportBtn.onclick = async () => { await this.exportCommentsToMarkdown(); };

        const sortBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "Sort by Time" : "Sort by Position");
        setIcon(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
        
        sortBtn.onclick = async () => {
            this.plugin.settings.commentSortOrder = this.plugin.settings.commentSortOrder === "position" ? "timestamp" : "position";
            await this.plugin.saveData();
            setIcon(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
            sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "Sort by Time" : "Sort by Position");
            this.renderCommentsList(commentsContainer);
        };

        const commentsContainer = this.containerEl.createDiv("sidenote-comments-list-wrapper");

        this.renderCommentsList(commentsContainer);

        // 修改点 3：渲染后恢复滚动位置
        if (this.lastScrollTop > 0) {
            // 使用 setTimeout 确保 DOM 渲染完成
            setTimeout(() => {
                commentsContainer.scrollTop = this.lastScrollTop;
            }, 0);
        }
    }

    private async exportCommentsToMarkdown() {
        // ... (保持不变) ...
        if (!this.file) { new Notice("No file selected."); return; }
        const comments = this.plugin.commentManager.getCommentsForFile(this.file.path);
        if (comments.length === 0) { new Notice("No comments to export."); return; }

        const sortedComments = [...comments].sort((a, b) => {
            if (a.startLine === b.startLine) return a.startChar - b.startChar;
            return a.startLine - b.startLine;
        });

        let content = `Source: [[${this.file.path}|${this.file.basename}]]\n\n`;
        sortedComments.forEach(c => {
            const quoteText = c.selectedText.replace(/\n/g, "\n> ");
            const commentBody = c.comment.replace(/\n/g, "\n>> ");
            // @ts-ignore
            const dateStr = window.moment(c.timestamp).format('YYYY-MM-DD HH:mm:ss');
            content += `> [!quote] sidenote\n> ${quoteText}\n>> [!note]+ ${dateStr}\n>> ${commentBody}\n\n`;
        });
        // @ts-ignore
        const filename = `${this.file.basename} - SideNote ${window.moment().format('YYYYMMDDHHmmss')}.md`;
        
        try {
            const file = await this.app.vault.create(filename, content);
            await this.app.workspace.getLeaf(true).openFile(file);
            new Notice(`Exported to ${filename}`);
        } catch (error) { new Notice("Error exporting file."); }
    }

    public renderCommentsList(container: HTMLElement) {
        container.empty();
        
        if (!this.file) {
            container.createDiv("sidenote-empty-state").createEl("p", { text: "No file selected." });
            return;
        }

        let commentsForFile = this.plugin.commentManager.getCommentsForFile(this.file.path);

        if (this.searchQuery) {
            commentsForFile = commentsForFile.filter(c => 
                (c.comment && c.comment.toLowerCase().includes(this.searchQuery)) || 
                (c.selectedText && c.selectedText.toLowerCase().includes(this.searchQuery))
            );
        }

        if (this.plugin.settings.commentSortOrder === "position") {
            commentsForFile.sort((a, b) => {
                if (a.startLine === b.startLine) return a.startChar - b.startChar;
                return a.startLine - b.startLine;
            });
        } else {
            commentsForFile.sort((a, b) => a.timestamp - b.timestamp);
        }

        if (commentsForFile.length > 0) {
            const listEl = container.createDiv("sidenote-comments-container");
            
            commentsForFile.forEach(async (comment) => {
                const commentEl = listEl.createDiv("sidenote-comment-item");
                commentEl.setAttribute("data-comment-timestamp", comment.timestamp.toString());
                
                if (this.activeCommentTimestamp === comment.timestamp) {
                    commentEl.addClass("active");
                }

                if (comment.color) {
                    const rgb = this.plugin.hexToRgb(comment.color);
                    const opacity = this.plugin.settings.highlightOpacity;
                    commentEl.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
                    commentEl.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
                    commentEl.style.setProperty('--interactive-accent', comment.color);
                    commentEl.style.setProperty('--interactive-accent-translucent', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);
                }

                const headerEl = commentEl.createDiv("sidenote-comment-header");
                const textInfoEl = headerEl.createDiv("sidenote-comment-text-info");
                textInfoEl.createEl("h4", { text: comment.selectedText, cls: "sidenote-selected-text" });
                textInfoEl.createEl("small", { text: new Date(comment.timestamp).toLocaleString(), cls: "sidenote-timestamp" });

                const actionsEl = headerEl.createDiv("sidenote-comment-actions");
                
                commentEl.onclick = async () => { 
                    this.activeCommentTimestamp = comment.timestamp;
                    // 保存当前的滚动位置（防止点击导致的重绘让列表跳动）
                    this.lastScrollTop = container.parentElement?.scrollTop || 0;
                    
                    container.querySelectorAll('.sidenote-comment-item').forEach(el => el.removeClass('active'));
                    commentEl.addClass('active');
                    await this.jumpToComment(comment); 
                };

                const contentWrapper = commentEl.createDiv({ cls: "sidenote-comment-content markdown-rendered" });
                await this.plugin.renderCommentContent(comment.comment || "", contentWrapper, comment.filePath);

                const menuButton = actionsEl.createEl("button", { cls: "sidenote-menu-button clickable-icon" });
                setIcon(menuButton, "more-vertical");
                const menuContainer = actionsEl.createDiv("sidenote-action-menu");

                const editOption = menuContainer.createEl("button", { text: "Edit", cls: "sidenote-menu-option" });
                editOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    
                    const rect = menuButton.getBoundingClientRect();
                    const position = { left: rect.right, top: rect.top, bottom: rect.bottom };

                    new FloatingCommentInput(this.app, this.plugin, (editedComment, color) => {
                        this.plugin.editComment(comment.timestamp, editedComment, color);
                    }, comment.comment, comment.filePath, comment.color || "").open(position);
                };

                const searchOption = menuContainer.createEl("button", { text: "Search in Vault", cls: "sidenote-menu-option" });
                searchOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    (this.app as any).internalPlugins.getPluginById('global-search').instance.openGlobalSearch(comment.selectedText);
                };

                const deleteOption = menuContainer.createEl("button", { text: "Delete", cls: "sidenote-menu-option sidenote-menu-delete" });
                deleteOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    this.plugin.deleteComment(comment.timestamp);
                };

                menuButton.onclick = (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.sidenote-action-menu.visible').forEach(el => {
                        if (el !== menuContainer) el.classList.remove('visible');
                    });
                    menuContainer.classList.toggle("visible");
                };

                document.addEventListener("click", (e) => {
                    if (!menuButton.contains(e.target as Node)) menuContainer.classList.remove("visible");
                }, { once: true, capture: true });
            });
        } else {
            const emptyStateEl = container.createDiv("sidenote-empty-state");
            emptyStateEl.createEl("p", { text: this.searchQuery ? "No comments match your search." : "No comments for this file yet." });
        }
    }
    
    public renderComments() { this.renderView(); }

    private async jumpToComment(comment: Comment) {
        // ... (保持不变) ...
        let targetLeaf: WorkspaceLeaf | null = null;
       this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
           if (leaf.view instanceof MarkdownView && leaf.view.file?.path === comment.filePath) {
               targetLeaf = leaf;
               return false;
           }
       });

       if (!targetLeaf) {
           const file = this.app.vault.getAbstractFileByPath(comment.filePath);
           if (file instanceof TFile) {
               const newLeaf = this.app.workspace.getLeaf(true);
               await newLeaf.openFile(file);
               targetLeaf = newLeaf;
           }
       }

       if (targetLeaf && targetLeaf.view instanceof MarkdownView) {
           this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
           if (Platform.isMobile) {
               // @ts-ignore
               this.app.workspace.leftSplit?.collapse();
               // @ts-ignore
               this.app.workspace.rightSplit?.collapse();
               await new Promise(resolve => setTimeout(resolve, 350));
           }

            const editor = targetLeaf.view.editor;
            const fileContent = editor.getValue();
            await this.plugin.commentManager.updateCommentCoordinatesForFile(fileContent, comment.filePath);
            await this.plugin.saveData();

            const updatedComment = this.plugin.comments.find(c => c.timestamp === comment.timestamp);
            if (!updatedComment || updatedComment.isOrphaned) {
                new Notice("Comment text not found in document.");
                return;
            }

            editor.focus();
            editor.setSelection(
                { line: updatedComment.startLine, ch: updatedComment.startChar }, 
                { line: updatedComment.endLine, ch: updatedComment.endChar }
            );
            editor.scrollIntoView({ from: { line: updatedComment.startLine, ch: 0 }, to: { line: updatedComment.endLine, ch: 0 } }, true);
        }
    }

    getState(): CustomViewState { return { filePath: this.file ? this.file.path : null }; }
    onunload() {}
}

async function switchToSideNoteView(app: App) {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) { new Notice("No active Markdown file found."); return; }
    let leaf = app.workspace.getLeaf('split', 'vertical');
    if (leaf) {
        await leaf.setViewState({ type: "sidenote-view", state: { filePath: activeFile.path }, active: true });
        void app.workspace.revealLeaf(leaf);
    }
}

// --- Floating Comment Input Class ---

class FloatingCommentInput {
    private app: App;
    private plugin: SideNote;
    private onSubmit: (comment: string, color?: string) => void;
    private initialComment: string;
    private filePath: string;
    private initialColor: string;
    private containerEl: HTMLElement;
    private textareaEl: HTMLTextAreaElement | null = null;
    private colorInput: HTMLInputElement | null = null;

    constructor(app: App, plugin: SideNote, onSubmit: (comment: string, color?: string) => void, initialComment: string = '', filePath: string = '', initialColor: string = '') {
        this.app = app;
        this.plugin = plugin;
        this.onSubmit = onSubmit;
        this.initialComment = initialComment;
        this.filePath = filePath;
        this.initialColor = initialColor;
    }

    open(position?: { left: number, top: number, bottom: number }) {
        this.containerEl = document.body.createDiv("sidenote-floating-container");
        
        const header = this.containerEl.createDiv("sidenote-floating-header");
        header.createEl("span", { text: this.initialComment ? "Edit Comment" : "Add Comment", cls: "sidenote-floating-title" });
        
        const closeBtn = header.createEl("button", { cls: "sidenote-floating-close clickable-icon" });
        setIcon(closeBtn, "x");
        closeBtn.onclick = () => this.close();

        this.enableDrag(header);

        const inputContainer = this.containerEl.createDiv("sidenote-floating-input-wrapper");
        const input = inputContainer.createEl("textarea");
        input.placeholder = "Enter comment... (Paste images supported)";
        input.value = this.initialComment;
        input.classList.add("sidenote-textarea");
        this.textareaEl = input;

        input.addEventListener('paste', this.handlePaste.bind(this));
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                this.submitComment();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        const footer = this.containerEl.createDiv("sidenote-floating-footer");
        
        const colorPickerWrapper = footer.createDiv("sidenote-floating-color-picker");
        colorPickerWrapper.style.marginRight = "auto";
        colorPickerWrapper.style.display = "flex";
        colorPickerWrapper.style.alignItems = "center";
        colorPickerWrapper.style.gap = "8px";
        colorPickerWrapper.createEl("span", { text: "Color:", cls: "sidenote-color-label" });
        this.colorInput = colorPickerWrapper.createEl("input", { type: "color", cls: "sidenote-color-input" });
        this.colorInput.value = this.initialColor || this.plugin.settings.highlightColor || "#FFC800";

        const cancelBtn = footer.createEl("button", { text: "Cancel", cls: "sidenote-floating-cancel-btn" });
        cancelBtn.style.marginRight = "8px";
        cancelBtn.onclick = () => this.close();

        const submitBtn = footer.createEl("button", { text: "Save", cls: "mod-cta" });
        submitBtn.onclick = () => this.submitComment();

        if (position) {
            this.setPosition(position);
        } else {
            this.containerEl.style.top = '40%';
            this.containerEl.style.left = '50%';
            this.containerEl.style.transform = 'translate(-50%, -50%)';
        }

        setTimeout(() => input.focus(), 50);
    }

    private enableDrag(dragHandle: HTMLElement) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        dragHandle.onmousedown = (e) => {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = this.containerEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            if (this.containerEl.style.transform) {
                this.containerEl.style.transform = 'none';
                this.containerEl.style.left = `${initialLeft}px`;
                this.containerEl.style.top = `${initialTop}px`;
            }

            const onMouseMove = (moveEvent: MouseEvent) => {
                if (!isDragging) return;
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;
                
                this.containerEl.style.left = `${initialLeft + dx}px`;
                this.containerEl.style.top = `${initialTop + dy}px`;
            };

            const onMouseUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
    }

    private setPosition(pos: { left: number, top: number, bottom: number }) {
        const height = 250; 
        const width = 320;
        const padding = 10;
        const windowHeight = window.innerHeight;
        const windowWidth = window.innerWidth;

        let top = pos.bottom + padding;
        let left = pos.left;

        if (top + height > windowHeight) top = pos.top - height - padding;
        if (left + width > windowWidth) left = windowWidth - width - padding;
        if (left < padding) left = padding;
        if (top < padding) top = padding;

        this.containerEl.style.top = `${top}px`;
        this.containerEl.style.left = `${left}px`;
        this.containerEl.style.transform = 'none';
    }

    close() {
        if (this.containerEl) {
            this.containerEl.remove();
        }
    }

    async handlePaste(e: ClipboardEvent) {
        if (!e.clipboardData) return;
        const files = e.clipboardData.files;
        if (files.length > 0) {
            e.preventDefault();
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.type.startsWith('image/')) {
                    await this.saveImageAndInsertLink(file);
                }
            }
        }
    }

    async saveImageAndInsertLink(file: File) {
        if (!this.textareaEl) return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            const binaryHash = await generateBinaryHash(arrayBuffer);
            let availablePath: string;

            if (this.plugin.imageHashes && this.plugin.imageHashes[binaryHash]) {
                const existingPath = this.plugin.imageHashes[binaryHash];
                const existingFile = this.app.vault.getAbstractFileByPath(existingPath);
                if (existingFile instanceof TFile) {
                    availablePath = existingPath;
                    new Notice("Reused existing image.");
                } else {
                    availablePath = await this.createNewImage(arrayBuffer, file.name);
                    this.plugin.imageHashes[binaryHash] = availablePath;
                    await this.plugin.saveData();
                }
            } else {
                availablePath = await this.createNewImage(arrayBuffer, file.name);
                if (!this.plugin.imageHashes) this.plugin.imageHashes = {};
                this.plugin.imageHashes[binaryHash] = availablePath;
                await this.plugin.saveData();
            }
            
            const savedFile = this.app.vault.getAbstractFileByPath(availablePath);
            if (savedFile instanceof TFile) {
                const sourcePath = this.filePath || '/'; 
                let markdownLink = this.app.fileManager.generateMarkdownLink(savedFile, sourcePath);
                if (!markdownLink.startsWith('!')) markdownLink = '!' + markdownLink;

                const startPos = this.textareaEl.selectionStart;
                const endPos = this.textareaEl.selectionEnd;
                const text = this.textareaEl.value;
                this.textareaEl.value = text.substring(0, startPos) + markdownLink + text.substring(endPos);
                const newCursorPos = startPos + markdownLink.length;
                this.textareaEl.setSelectionRange(newCursorPos, newCursorPos);
                this.textareaEl.dispatchEvent(new Event('input'));
            }
        } catch (error) { console.error(error); new Notice('Failed to save image.'); }
    }

    async createNewImage(arrayBuffer: ArrayBuffer, originalName: string): Promise<string> {
        const folderSetting = this.plugin.settings.attachmentFolder.trim() || "side-note-attachments";
        const folderPath = normalizePath(folderSetting);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) await this.app.vault.createFolder(folderPath);

        // @ts-ignore
        const dateStr = window.moment().format('YYYYMMDDHHmmss');
        const extension = originalName.split('.').pop() || 'png';
        const fileName = `Pasted image ${dateStr}.${extension}`;
        const targetPath = `${folderPath}/${fileName}`;

        const fileOrPath = await this.app.vault.createBinary(targetPath, arrayBuffer).catch(async () => {
             // @ts-ignore
            return await this.app.fileManager.getAvailablePathForAttachment(fileName, folderPath);
        });
        return fileOrPath instanceof TFile ? fileOrPath.path : (fileOrPath as string);
    }
    
    async submitComment() {
        if (this.textareaEl) {
            const comment = this.textareaEl.value;
            const color = this.colorInput?.value;
            try { this.onSubmit(comment, color); } catch (e) { console.error(e); }
            this.close();
        }
    }
}

// --- Setting Tab ---

class SideNoteSettingTab extends PluginSettingTab {
    plugin: SideNote;
    constructor(app: App, plugin: SideNote) { super(app, plugin); }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName("Comment sort order").setDesc("Choose how comments are sorted.")
            .addDropdown((dropdown) => dropdown.addOption("timestamp", "By timestamp").addOption("position", "By position in file")
                .setValue(this.plugin.settings.commentSortOrder).onChange(async (value: "timestamp" | "position") => {
                    this.plugin.settings.commentSortOrder = value;
                    await this.plugin.saveData();
                    this.plugin.refreshViews();
                }));
        new Setting(containerEl).setName("Show highlights in editor").setDesc("Display highlights for commented text.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.showHighlights).onChange(async (value: boolean) => {
                    this.plugin.settings.showHighlights = value;
                    await this.plugin.saveData();
                    this.plugin.refreshEditorDecorations();
                }));
        new Setting(containerEl).setName("Enable selection toolbar").setDesc("Show a quick action toolbar when text is selected.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableSelectionToolbar).onChange(async (value: boolean) => {
                    this.plugin.settings.enableSelectionToolbar = value;
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("Highlight color").addColorPicker((colorPicker) =>
                colorPicker.setValue(this.plugin.settings.highlightColor || "#FFC800").onChange(async (value: string) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveData();
                    this.plugin.applyHighlightColor();
                }));
        new Setting(containerEl).setName("Highlight opacity").addSlider((slider) =>
                slider.setLimits(0, 1, 0.1).setValue(this.plugin.settings.highlightOpacity || 0.2).onChange(async (value: number) => {
                    this.plugin.settings.highlightOpacity = value;
                    await this.plugin.saveData();
                    this.plugin.applyHighlightColor();
                }));
        new Setting(containerEl).setName("Markdown comments folder").addText((text) =>
                text.setPlaceholder("side-note-comments").setValue(this.plugin.settings.markdownFolder || "").onChange(async (value) => {
                    this.plugin.settings.markdownFolder = value.trim() || "side-note-comments";
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("Attachments folder").addText((text) =>
                text.setPlaceholder("side-note-attachments").setValue(this.plugin.settings.attachmentFolder || "").onChange(async (value) => {
                    this.plugin.settings.attachmentFolder = value.trim() || "side-note-attachments";
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("Create Markdown Backup").addButton((button) =>
                button.setButtonText("Create Backup").onClick(async () => {
                    await this.plugin.migrateInlineCommentsToMarkdown();
                    new Notice("Markdown backup created successfully!");
                }));
        const orphanedCount = this.plugin.commentManager.getOrphanedCommentCount();
        new Setting(containerEl).setName("Orphaned comments").setDesc(`There are ${orphanedCount} orphaned comment(s).`);
        new Setting(containerEl).addButton((button) =>
                button.setButtonText(`Delete ${orphanedCount} orphaned comment(s)`).setWarning().onClick(async () => {
                    const deleted = this.plugin.commentManager.deleteOrphanedComments();
                    await this.plugin.saveData();
                    this.plugin.refreshViews();
                    new Notice(`Deleted ${deleted} orphaned comment(s)!`);
                    this.display();
                }).setDisabled(orphanedCount === 0));
    }
}

// --- Main Plugin Class ---

export default class SideNote extends Plugin {
    commentManager: CommentManager;
    settings: SideNoteSettings;
    comments: Comment[] = [];
    imageHashes: Record<string, string> = {};

    public async renderCommentContent(markdown: string, container: HTMLElement, sourcePath: string) {
        const component = new Component();
        component.load();
        await MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component);
        container.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest("a");
            if (link) {
                e.stopPropagation();
                if (link.classList.contains("internal-link")) {
                    e.preventDefault();
                    const href = link.getAttribute("data-href");
                    if (href) {
                        const newLeaf = e.metaKey || e.ctrlKey;
                        this.app.workspace.openLinkText(href, sourcePath, newLeaf);
                    }
                }
            }
        });
        const embedRegex = /!\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g;
        let match;
        while ((match = embedRegex.exec(markdown)) !== null) {
            const filename = match[1];
            const file = this.app.metadataCache.getFirstLinkpathDest(filename, sourcePath);
            if (file instanceof TFile) {
                const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
                let textNode;
                while ((textNode = walker.nextNode())) {
                    if (textNode.textContent?.includes(match[0])) {
                        const embedSpan = document.createElement('span');
                        embedSpan.className = 'internal-embed';
                        const img = document.createElement('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.style.maxWidth = '100%';
                        img.style.display = 'block';
                        embedSpan.appendChild(img);
                        const parent = textNode.parentNode;
                        if (parent) {
                            const parts = textNode.textContent.split(match[0]);
                            parent.insertBefore(document.createTextNode(parts[0]), textNode);
                            parent.insertBefore(embedSpan, textNode);
                            textNode.textContent = parts.slice(1).join(match[0]);
                        }
                        break; 
                    }
                }
            }
        }
        container.querySelectorAll('.internal-embed').forEach((embed) => {
            if (embed instanceof HTMLElement && !embed.querySelector('img')) {
                const src = embed.getAttribute('src') || embed.getAttribute('alt') || embed.textContent?.replace(/^\[\[|\]\]$/g, '');
                 if (src) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
                    if (file instanceof TFile) {
                        embed.empty();
                        const img = embed.createEl('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.style.maxWidth = '100%';
                        img.style.display = 'block';
                    }
                 }
            }
        });
    }

    public refreshViews() {
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
        });
    }

    private async ensureCommentFolder(): Promise<string> {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        if (!(await this.app.vault.adapter.exists(normalized))) await this.app.vault.createFolder(normalized);
        return normalized;
    }

    private getSideNoteFilePath(notePath: string): string {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}-sidenote.md`;
    }

    private buildMarkdownBlock(excerpt: string, body: string, timestamp: number): string {
        const safeExcerpt = excerpt || "(no excerpt)";
        return `## ${safeExcerpt}\n\n${body}\n\n---`;
    }

    private async writeCommentToMarkdown(notePath: string, excerpt: string, body: string, timestamp: number): Promise<string> {
        const folder = await this.ensureCommentFolder();
        const filePath = this.getSideNoteFilePath(notePath);
        const block = this.buildMarkdownBlock(excerpt, body, timestamp);
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            const content = await this.app.vault.read(existing);
            const updated = content.trim().length === 0 ? block : `${content}\n\n${block}`;
            await this.app.vault.modify(existing, updated);
        } else {
            const header = `# Side Notes for ${notePath}\n\n`;
            await this.app.vault.create(filePath, `${header}${block}`);
        }
        return filePath;
    }

    async migrateInlineCommentsToMarkdown() {
        let changed = false;
        for (const comment of this.comments) {
            if (!comment.commentPath) {
                const path = await this.writeCommentToMarkdown(comment.filePath, comment.selectedText, comment.comment, comment.timestamp);
                comment.commentPath = path;
                changed = true;
            }
        }
        if (changed) await this.saveData();
    }

    // --- 捕获上下文的辅助函数 ---
    private getSelectionContext(editor: Editor): { before: string, after: string } {
        const doc = editor.getValue();
        const cursorFrom = editor.posToOffset(editor.getCursor("from"));
        const cursorTo = editor.posToOffset(editor.getCursor("to"));
        
        // 获取前文锚点 (最多50字符)
        const start = Math.max(0, cursorFrom - 50);
        const contextBefore = doc.substring(start, cursorFrom);
        
        // 获取后文锚点 (最多50字符)
        const end = Math.min(doc.length, cursorTo + 50);
        const contextAfter = doc.substring(cursorTo, end);

        return { before: contextBefore, after: contextAfter };
    }

    public async handleAddComment(editor: Editor, view: MarkdownView | import("obsidian").MarkdownFileInfo, markType: 'highlight' | 'underline' | 'strikethrough' | 'bold', initialColor?: string) {
        const selection = editor.getSelection();
        const filePath = view.file?.path;
        if (selection && selection.trim().length > 0 && filePath) {
            const cursorStart = editor.getCursor("from");
            const cursorEnd = editor.getCursor("to");
            
            // 获取上下文锚点
            const { before, after } = this.getSelectionContext(editor);
            
            // @ts-ignore
            const cm = (editor as any).cm; 
            // @ts-ignore
            const coords = cm.coordsAtPos(editor.posToOffset(editor.getCursor("to")));

            new FloatingCommentInput(this.app, this, async (comment, color) => {
                const selectedTextHash = await generateHash(selection);
                const newComment: Comment = {
                    filePath: filePath, startLine: cursorStart.line, startChar: cursorStart.ch,
                    endLine: cursorEnd.line, endChar: cursorEnd.ch, selectedText: selection,
                    selectedTextHash: selectedTextHash, comment: comment, timestamp: Date.now(), isOrphaned: false,
                    // 保存上下文
                    contextBefore: before,
                    contextAfter: after,
                    markType: markType,
                    color: color
                };
                this.addComment(newComment);
            }, "", filePath, initialColor || "").open(coords);
        } else {
            new Notice("Please select some text to add a comment.");
        }
    }

    async onload() {
        this.injectStyles(); // 只注入动态变量
        await this.loadPluginData();
        this.commentManager = new CommentManager(this.comments);
        await this.migrateComments();
        this.registerEditorExtension([this.createSelectionToolbarPlugin(), ...this.createHighlightPlugin()]);
        this.addSettingTab(new SideNoteSettingTab(this.app, this));
        this.registerView("sidenote-view", (leaf) => new SideNoteView(leaf, this));

        this.addCommand({ id: "open-comment-view", name: "Open in Split View", callback: () => void switchToSideNoteView(this.app) });
        this.addCommand({ id: "activate-view", name: "Open in Sidebar", callback: () => this.activateView() });
        
        this.addCommand({
            id: "add-comment-to-selection", name: "Add comment to selection (Highlight)", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'highlight')
        });
        this.addCommand({
            id: "add-underline-comment-to-selection", name: "Add comment to selection (Underline)", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'underline')
        });
        this.addCommand({
            id: "add-strikethrough-comment-to-selection", name: "Add comment to selection (Strikethrough)", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'strikethrough')
        });
        this.addCommand({
            id: "add-bold-comment-to-selection", name: "Add comment to selection (Bold)", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'bold')
        });

        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
            if (editor.somethingSelected()) {
                menu.addItem((item) => {
                    item.setTitle("Add comment (Highlight)").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'highlight'));
                });
                menu.addItem((item) => {
                    item.setTitle("Add comment (Underline)").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'underline'));
                });
                menu.addItem((item) => {
                    item.setTitle("Add comment (Strikethrough)").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'strikethrough'));
                });
                menu.addItem((item) => {
                    item.setTitle("Add comment (Bold)").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'bold'));
                });
            }
        }));

        this.addRibbonIcon("message-square", "Side Note: Open in Sidebar", () => this.activateView());
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && leaf.view instanceof MarkdownView) {
                const file = leaf.view.file;
                this.app.workspace.getLeavesOfType("sidenote-view").forEach(sideNoteLeaf => {
                    if (sideNoteLeaf.view instanceof SideNoteView) sideNoteLeaf.view.updateActiveFile(file);
                });
                this.refreshEditorDecorations();
            }
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
                this.commentManager.renameFile(oldPath, file.path);
                void this.saveData();
                this.refreshViews();
            }
        }));
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === '.obsidian/plugins/side-note/data.json' || (file instanceof TFile && file.name === 'data.json' && file.parent?.name === 'side-note')) {
                try {
                    await this.loadPluginData();
                    this.commentManager.updateComments(this.comments);
                    this.refreshViews();
                } catch (error) { console.error("Error reloading plugin data:", error); }
            } else if (file instanceof TFile && file.extension === 'md') {
                try {
                    const fileContent = await this.app.vault.read(file);
                    await this.commentManager.updateCommentCoordinatesForFile(fileContent, file.path);
                    await this.saveData();
                    this.refreshViews();
                } catch (error) { console.error("Error updating comment coordinates:", error); }
            }
        }));
    }

    private injectStyles() {
        const styleId = "sidenote-dynamic-styles";
        let styleTag = document.getElementById(styleId);
        if (!styleTag) {
            styleTag = document.createElement("style");
            styleTag.id = styleId;
            document.head.appendChild(styleTag);
        }
        // 仅保留需要 JavaScript 动态计算的颜色变量
        // 具体的 CSS 样式规则现在由 styles.css 文件接管
        styleTag.innerHTML = `
            :root {
                --sidenote-highlight-color: rgba(255, 208, 0, 0.2);
                --sidenote-highlight-hover: rgba(255, 208, 0, 0.4);
                --sidenote-highlight-border: rgba(255, 208, 0, 0.6);
                --sidenote-orphaned-color: rgba(255, 80, 80, 0.2);
                --sidenote-orphaned-hover: rgba(255, 80, 80, 0.3);
                --sidenote-orphaned-border: rgba(255, 80, 80, 0.6);
            }
        `;
    }

    async activateViewAndHighlightComment(timestamp: number) {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType("sidenote-view");
        leaves.forEach(leaf => { if (leaf.view instanceof SideNoteView) leaf.view.highlightComment(timestamp); });
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType("sidenote-view");
        if (leaves.length > 0) leaf = leaves[0];
        else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) { leaf = rightLeaf; await leaf.setViewState({ type: "sidenote-view", active: true }); }
        }
        if (leaf) {
            workspace.revealLeaf(leaf);
            if (leaf.view instanceof SideNoteView) {
                const activeFile = workspace.getActiveFile();
                leaf.view.updateActiveFile(activeFile);
            }
        }
    }

    async onCommentsChanged(message: string) {
        await this.saveData();
        this.refreshViews();
        this.refreshEditorDecorations();
        new Notice(message);
    }

    async addComment(newComment: Comment) {
        this.commentManager.addComment(newComment);
        void this.onCommentsChanged("Comment added!");
    }

    async editComment(timestamp: number, newCommentText: string, newColor?: string) {
        this.commentManager.editComment(timestamp, newCommentText, newColor);
        void this.onCommentsChanged("Comment updated!");
    }

    async deleteComment(timestamp: number) {
        this.commentManager.deleteComment(timestamp);
        void this.onCommentsChanged("Comment deleted!");
    }

    async loadPluginData() {
        const loadedData: PluginData = Object.assign({}, { comments: [], imageHashes: {} }, DEFAULT_SETTINGS, await this.loadData());
        this.settings = { ...DEFAULT_SETTINGS, ...loadedData };
        this.comments = loadedData.comments || [];
        this.imageHashes = loadedData.imageHashes || {};
        this.applyHighlightColor();
    }

    async migrateComments() {
        let needsSave = false;
        for (const comment of this.comments) {
            if (!comment.selectedTextHash && comment.selectedText) {
                comment.selectedTextHash = await generateHash(comment.selectedText);
                needsSave = true;
            }
            if (comment.isOrphaned === undefined) {
                comment.isOrphaned = false;
                needsSave = true;
            }
        }
        if (needsSave) await this.saveData();
    }

    applyHighlightColor() {
        const root = document.documentElement;
        const rgb = this.hexToRgb(this.settings.highlightColor);
        const opacity = this.settings.highlightOpacity;
        root.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
        root.style.setProperty('--sidenote-highlight-hover', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
        root.style.setProperty('--sidenote-orphaned-color', `rgba(255, 100, 100, ${opacity})`);
        root.style.setProperty('--sidenote-orphaned-hover', `rgba(255, 100, 100, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-orphaned-border', `rgba(255, 100, 100, ${Math.min(opacity + 0.35, 1)})`);
        this.refreshEditorDecorations();
    }

    hexToRgb(hex: string): { r: number; g: number; b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 255, g: 200, b: 0 };
    }

    async saveData() {
        const dataToSave: PluginData = { ...this.settings, comments: this.comments, imageHashes: this.imageHashes };
        await super.saveData(dataToSave);
        this.refreshEditorDecorations();
    }

    refreshEditorDecorations() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                const editor = leaf.view.editor;
                if (editor && (editor as any).cm) {
                    const cm = (editor as any).cm;
                    if (cm.dispatch) cm.dispatch({ effects: [forceUpdateEffect.of(null)] });
                }
            }
        });
    }

    private createSelectionToolbarPlugin() {
        const plugin = this;
        return ViewPlugin.fromClass(class {
            toolbar: HTMLElement | null = null;
            view: EditorView;
            
            constructor(view: EditorView) {
                this.view = view;
            }

            update(update: ViewUpdate) {
                if (update.selectionSet || update.viewportChanged) {
                    setTimeout(() => this.checkSelection(), 10);
                }
            }

            checkSelection() {
                if (!plugin.settings.enableSelectionToolbar) {
                    this.hideToolbar();
                    return;
                }
                const selection = this.view.state.selection.main;
                if (!selection.empty && selection.to - selection.from > 0) {
                    const text = this.view.state.sliceDoc(selection.from, selection.to);
                    if (text.trim().length > 0) {
                        this.showToolbar(selection);
                        return;
                    }
                }
                this.hideToolbar();
            }

            showToolbar(selection: any) {
                if (!this.toolbar) {
                    this.toolbar = document.createElement("div");
                    this.toolbar.className = "sidenote-selection-toolbar";
                    document.body.appendChild(this.toolbar);
                    this.buildToolbarUI();
                    
                    this.toolbar.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                    });
                }
                
                const coords = this.view.coordsAtPos(selection.to);
                const fromCoords = this.view.coordsAtPos(selection.from);
                if (coords && fromCoords) {
                    const top = Math.min(coords.top, fromCoords.top);
                    const left = (coords.left + fromCoords.left) / 2;
                    this.toolbar.style.left = `${left}px`;
                    this.toolbar.style.top = `${top}px`;
                }
            }

            hideToolbar() {
                if (this.toolbar) {
                    this.toolbar.remove();
                    this.toolbar = null;
                }
            }

            destroy() {
                this.hideToolbar();
            }

            buildToolbarUI() {
                if (!this.toolbar) return;
                
                const colorPicker = document.createElement('input');
                colorPicker.type = 'color';
                colorPicker.className = 'sidenote-toolbar-color-picker';
                colorPicker.value = plugin.settings.highlightColor || "#FFC800";
                
                const createBtn = (iconName: string, tooltip: string, markType: 'highlight' | 'underline' | 'strikethrough' | 'bold') => {
                    const btn = document.createElement('button');
                    btn.className = 'sidenote-toolbar-btn';
                    btn.title = tooltip;
                    setIcon(btn, iconName);
                    btn.onclick = () => {
                        const editor = plugin.app.workspace.activeEditor?.editor;
                        const view = plugin.app.workspace.activeEditor;
                        if (editor && view) {
                            const color = colorPicker.value;
                            plugin.handleAddComment(editor, view, markType, color);
                        }
                    };
                    return btn;
                };

                const highlighterBtn = createBtn('highlighter', 'Highlight', 'highlight');
                const underlineBtn = createBtn('underline', 'Underline', 'underline');
                const strikethroughBtn = createBtn('strikethrough', 'Strikethrough', 'strikethrough');
                const boldBtn = createBtn('bold', 'Bold', 'bold');

                const divider = document.createElement('div');
                divider.className = 'sidenote-toolbar-divider';

                this.toolbar.appendChild(highlighterBtn);
                this.toolbar.appendChild(underlineBtn);
                this.toolbar.appendChild(strikethroughBtn);
                this.toolbar.appendChild(boldBtn);
                this.toolbar.appendChild(divider);
                this.toolbar.appendChild(colorPicker);
            }
        });
    }

    private createHighlightPlugin() {
        const plugin = this;
        const commentTooltip = hoverTooltip((view, pos, side) => {
            let filePath: string | null = null;
            plugin.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view instanceof MarkdownView && leaf.view.file) {
                    const editor = leaf.view.editor;
                    if (editor && (editor as any).cm === view) filePath = leaf.view.file.path;
                }
            });
            if (!filePath) return null;

            const comments = plugin.commentManager.getCommentsForFile(filePath);
            const { doc } = view.state;
            const hoveredComment = comments.find(comment => {
                if (comment.isOrphaned) return false;
                try {
                    const line = doc.line(comment.startLine + 1);
                    const from = line.from + comment.startChar;
                    const to = comment.isOrphaned ? Math.min(from + 1, line.to) : line.from + comment.endChar;
                    return pos >= from && pos <= to;
                } catch { return false; }
            });

            if (!hoveredComment) return null;

            return {
                pos, above: true, arrow: false, offset: { x: 0, y: 14 },
                create(view) {
                    const dom = document.createElement("div");
                    dom.className = "sidenote-tooltip";
                    const content = dom.createDiv("sidenote-tooltip-content markdown-rendered");
                    (async () => {
                        await plugin.renderCommentContent(hoveredComment.comment || "", content, hoveredComment.filePath);
                    })();
                    return { dom };
                }
            };
        });

        const highlightPlugin = ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            view: EditorView;
            constructor(view: EditorView) {
                this.view = view;
                this.decorations = this.buildDecorations(view);
                this.view.dom.addEventListener('click', this.handleClick.bind(this));
            }
            destroy() { this.view.dom.removeEventListener('click', this.handleClick.bind(this)); }
            handleClick(event: MouseEvent) {
                const target = event.target as HTMLElement;
                const highlight = target.closest('.sidenote-highlight');
                if (highlight) {
                    const timestampStr = highlight.getAttribute('data-comment-timestamp');
                    if (timestampStr) {
                        const timestamp = parseInt(timestampStr, 10);
                        plugin.activateViewAndHighlightComment(timestamp);
                    }
                }
            }
            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.some(e => e.is(forceUpdateEffect)))) {
                    this.decorations = this.buildDecorations(update.view);
                }
            }
            buildDecorations(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                if (!plugin.settings.showHighlights) return builder.finish();
                
                let filePath: string | null = null;
                plugin.app.workspace.iterateAllLeaves((leaf) => {
                    if (leaf.view instanceof MarkdownView && leaf.view.file) {
                        const editor = leaf.view.editor;
                        if (editor && (editor as any).cm === view) filePath = leaf.view.file.path;
                    }
                });
                if (!filePath) return builder.finish();

                const comments = plugin.commentManager.getCommentsForFile(filePath);
                const doc = view.state.doc;
                const decorationsArray: Array<{from: number, to: number, decoration: Decoration}> = [];

                comments.forEach(comment => {
                    try {
                        const line = doc.line(comment.startLine + 1);
                        const from = line.from + comment.startChar;
                        const to = comment.isOrphaned ? Math.min(from + 1, line.to) : line.from + comment.endChar;
                        
                        if (from >= 0 && to <= doc.length && from < to) {
                            const attributes: Record<string, string> = { 'data-comment-timestamp': comment.timestamp.toString() };
                            if (comment.color) {
                                const rgb = plugin.hexToRgb(comment.color);
                                const opacity = plugin.settings.highlightOpacity;
                                attributes.style = `--sidenote-highlight-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); ` +
                                                   `--sidenote-highlight-hover: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)}); ` +
                                                   `--sidenote-highlight-border: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)});`;
                            }
                            decorationsArray.push({
                                from, to,
                                decoration: Decoration.mark({
                                    class: `sidenote-highlight${comment.isOrphaned ? ' orphaned' : ''} sidenote-mark-${comment.markType || 'highlight'}`,
                                    attributes: attributes
                                })
                            });
                        }
                    } catch (e) {}
                });
                decorationsArray.sort((a, b) => a.from - b.from);
                decorationsArray.forEach(({ from, to, decoration }) => builder.add(from, to, decoration));
                return builder.finish();
            }
        }, { decorations: (v: any) => v.decorations });

        return [highlightPlugin, commentTooltip];
    }
}