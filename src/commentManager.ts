// Helper function to generate SHA256 hash (works on both desktop and mobile)
async function generateHash(text: string): Promise<string> {
    try {
        // Web Crypto API (works on mobile)
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
        // Fallback to Node.js crypto for desktop
        try {
            const nodeCrypto = require('crypto');
            return nodeCrypto.createHash('sha256').update(text).digest('hex');
        } catch {
            // Simple fallback hash
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

export interface Comment {
    filePath: string;
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
    selectedText: string;
    selectedTextHash: string;
    comment: string;
    timestamp: number;
    isOrphaned?: boolean;
    commentPath?: string; // Path to markdown-stored comment (optional)
    
    // --- 新增：上下文锚点 ---
    // 用于在行号失效或文本微调后重新定位
    contextBefore?: string; 
    contextAfter?: string;

    // --- 新增：批注形式 ---
    markType?: 'highlight' | 'underline' | 'strikethrough' | 'bold';
    
    // --- 新增：批注颜色 ---
    color?: string;
}

export class CommentManager {
    private comments: Comment[];
    private readonly MIN_TEXT_LENGTH = 3; 

    constructor(comments: Comment[]) {
        this.comments = comments;
    }

    getCommentsForFile(filePath: string): Comment[] {
        return this.comments.filter(comment => comment.filePath === filePath);
    }

    async addComment(newComment: Comment): Promise<void> {
        // Generate hash if not present
        if (!newComment.selectedTextHash) {
            newComment.selectedTextHash = await generateHash(newComment.selectedText);
        }
        this.comments.push(newComment);
    }

    editComment(timestamp: number, newCommentText: string, newColor?: string): void {
        const commentToEdit = this.comments.find(comment => comment.timestamp === timestamp);
        if (commentToEdit) {
            commentToEdit.comment = newCommentText;
            if (newColor) commentToEdit.color = newColor;
        }
    }

    deleteComment(timestamp: number): void {
        const indexToDelete = this.comments.findIndex(comment => comment.timestamp === timestamp);
        if (indexToDelete > -1) {
            this.comments.splice(indexToDelete, 1);
        }
    }

    deleteOrphanedComments(): number {
        const initialLength = this.comments.length;
        for (let i = this.comments.length - 1; i >= 0; i--) {
            if (this.comments[i].isOrphaned) {
                this.comments.splice(i, 1);
            }
        }
        return initialLength - this.comments.length;
    }

    getOrphanedComments(): Comment[] {
        return this.comments.filter(comment => comment.isOrphaned);
    }

    getOrphanedCommentCount(): number {
        return this.comments.filter(comment => comment.isOrphaned).length;
    }

    renameFile(oldPath: string, newPath: string): void {
        this.comments.forEach(comment => {
            if (comment.filePath === oldPath) {
                comment.filePath = newPath;
            }
        });
    }

    updateComments(newComments: Comment[]): void {
        this.comments = newComments;
    }

    getComments(): Comment[] {
        return this.comments;
    }

    // --- 核心定位逻辑重构 ---

    /**
     * 将绝对索引转换为行号和列号
     */
    private getPositionFromIndex(content: string, index: number): { line: number; ch: number } {
        // 边界检查
        if (index < 0) return { line: 0, ch: 0 };
        if (index > content.length) index = content.length;

        const textBefore = content.substring(0, index);
        const lines = textBefore.split('\n');
        const line = lines.length - 1;
        const ch = lines[lines.length - 1].length;
        return { line, ch };
    }

    /**
     * 根据行号和列号估算在当前文档中的绝对索引位置
     * 用于在有多个匹配项时，找到离原位置最近的那个
     */
    private getApproximateIndex(content: string, line: number, char: number): number {
        const lines = content.split('\n');
        let index = 0;
        // 累加前 n 行的长度
        for (let i = 0; i < Math.min(line, lines.length); i++) {
            index += lines[i].length + 1; // +1 for newline character
        }
        return index + char;
    }

    /**
     * 更新评论坐标的核心方法
     * 采用三级降级策略：上下文锚点 -> 全文哈希 -> 原始文本匹配
     */
    async updateCommentCoordinatesForFile(fileContent: string, filePath: string): Promise<void> {
        const fileComments = this.comments.filter(comment => comment.filePath === filePath);

        for (const comment of fileComments) {
            // 如果已经是孤儿，尝试一次“复活”，失败则维持现状
            // 如果不是孤儿，则进行常规更新检查

            let matchIndex = -1;
            let matchText = comment.selectedText;
            
            // 估算旧位置的绝对索引，用于多重匹配时的距离排序
            const estimatedOldIndex = this.getApproximateIndex(fileContent, comment.startLine, comment.startChar);

            // --- 策略 1: 上下文锚点匹配 (最强稳健性) ---
            // 即使行号变了、选中文本被微调了，只要前后文还在，就能找到
            if (comment.contextBefore && comment.contextAfter) {
                const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                // 取最近的上下文片段（防止上下文过长导致正则性能问题）
                // 建议取 20-30 个字符
                const beforeSnippet = comment.contextBefore.slice(-30);
                const afterSnippet = comment.contextAfter.slice(0, 30);

                if (beforeSnippet && afterSnippet) {
                    const before = escapeRegExp(beforeSnippet);
                    const after = escapeRegExp(afterSnippet);
                    
                    // 构造正则：查找 "前文 + (任意非贪婪内容) + 后文"
                    // [\s\S]*? 匹配任意字符包括换行
                    const regex = new RegExp(`${before}([\\s\\S]*?)${after}`, 'g');
                    
                    const matches = [...fileContent.matchAll(regex)];
                    
                    if (matches.length > 0) {
                        // 按照距离旧位置的远近排序
                        matches.sort((a, b) => {
                            const distA = Math.abs((a.index || 0) - estimatedOldIndex);
                            const distB = Math.abs((b.index || 0) - estimatedOldIndex);
                            return distA - distB;
                        });
                        
                        const bestMatch = matches[0];
                        if (bestMatch.index !== undefined) {
                            // bestMatch[0] 是完整匹配串 (before + text + after)
                            // bestMatch[1] 是捕获组，即中间的实际文本
                            
                            // 计算中间文本的开始位置： 匹配起始 + 前文片段在全匹配中的位置(通常是0) + 前文片段长度
                            // 但由于正则可能有部分重叠风险，直接用 indexOf 确认 bestMatch[1] 在 bestMatch[0] 中的偏移更稳妥
                            // 简单起见： index + beforeSnippet.length
                            matchIndex = bestMatch.index + bestMatch[0].indexOf(bestMatch[1]);
                            matchText = bestMatch[1]; 
                        }
                    }
                }
            }

            // --- 策略 2: 全文哈希搜索 (抗大范围移动) ---
            // 如果上下文匹配失败（比如周围被改得面目全非），但选中的文字本身没变，我们全文档搜它
            if (matchIndex === -1 && comment.selectedTextHash) {
                // 优化：不遍历所有子串，而是查找所有原文出现的索引，再验证哈希（极快）
                // 如果原文被修改了，这里会搜不到，但策略1通常能覆盖修改的情况
                
                // 1. 尝试直接搜索原文 (最快)
                let candidates: number[] = [];
                let searchPos = 0;
                while (true) {
                    const found = fileContent.indexOf(comment.selectedText, searchPos);
                    if (found === -1) break;
                    
                    // 验证 Hash (防止哈希碰撞，虽然极低概率，但保持逻辑一致)
                    // 只有当原文真的很长时才有必要，短文本直接认定匹配
                    const candidateHash = await generateHash(comment.selectedText);
                    if (candidateHash === comment.selectedTextHash) {
                         candidates.push(found);
                    }
                    searchPos = found + 1;
                }

                if (candidates.length > 0) {
                    // 找离原位置最近的
                    candidates.sort((a, b) => Math.abs(a - estimatedOldIndex) - Math.abs(b - estimatedOldIndex));
                    matchIndex = candidates[0];
                }
            }

            // --- 策略 3: 纯文本回退 (Legacy) ---
            // 针对旧数据（没有哈希或上下文）的最后防线
            if (matchIndex === -1 && comment.selectedText && !comment.selectedTextHash) {
                matchIndex = fileContent.indexOf(comment.selectedText);
                // 同样可以做最近距离优化，这里简化处理
            }

            // --- 应用更新 ---
            if (matchIndex !== -1) {
                // 计算新的行号列号
                const newStart = this.getPositionFromIndex(fileContent, matchIndex);
                const newEnd = this.getPositionFromIndex(fileContent, matchIndex + matchText.length);

                comment.startLine = newStart.line;
                comment.startChar = newStart.ch;
                comment.endLine = newEnd.line;
                comment.endChar = newEnd.ch;
                
                // 关键：如果文本因为策略1（模糊匹配）发生了变化，需要更新它
                if (matchText !== comment.selectedText) {
                    comment.selectedText = matchText;
                    comment.selectedTextHash = await generateHash(matchText);
                }

                comment.isOrphaned = false;
            } else {
                // 实在找不到了，标记为孤儿
                comment.isOrphaned = true;
            }
        }
    }
}