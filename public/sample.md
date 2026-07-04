# MD Reader 示例文档

欢迎使用 **MD Reader** — 一个轻量级 Markdown 阅读器！

## 功能演示

### 文本格式

这是一段普通文本。支持 **粗体**、*斜体*、~~删除线~~、`行内代码`。

也可以组合使用：**粗体中嵌套 *斜体***。

### 链接与图片

[访问 GitHub](https://github.com)

![示例图片](https://picsum.photos/600/300)

### 引用

> 好的工具应该像一把好刀——用起来顺手，放下来不占地方。
>
> — 某个不存在的人

### 列表

#### 无序列表

- 📖 沉浸式阅读体验
- 🎨 三种主题切换
- ⚡ 极速启动
- 📦 便携版免安装

#### 有序列表

1. 下载并安装
2. 双击打开 .md 文件
3. 开始阅读

#### 任务列表

- [x] 支持 GFM 语法
- [x] 代码高亮
- [x] 目录导航
- [ ] 数学公式（计划中）
- [ ] Mermaid 图表（计划中）

### 代码块

```javascript
// JavaScript 示例
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10)); // 55
```

```python
# Python 示例
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))  # 55
```

```rust
// Rust 示例
fn fibonacci(n: u64) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}

fn main() {
    println!("{}", fibonacci(10)); // 55
}
```

### 表格

| 框架 | 启动速度 | 包体积 | 内存占用 |
|------|---------|--------|---------|
| Tauri | ⚡ 极快 | ~10MB | ~30MB |
| Electron | 🐢 慢 | ~150MB | ~200MB |
| Flutter | 中等 | ~30MB | ~80MB |

### 分割线

---

### 数学公式（行内）

当 $n \to \infty$ 时，斐波那契数列的相邻两项之比趋近于黄金比例 $\phi = \frac{1+\sqrt{5}}{2}$。

### 嵌套引用

> 第一层引用
>
> > 第二层引用
> >
> > > 第三层引用

---

*感谢使用 MD Reader ❤️*
