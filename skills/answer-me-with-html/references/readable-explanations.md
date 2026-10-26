# Clear main text, optional detail

The reader should understand the point, why it matters and a concrete use without clicking. Keep the conditions that change the conclusion in the visible text. Expand optional depth: full source lists, long comparisons, additional cases and implementation details.

Use connected paragraphs when they explain a relationship. Use a table or diagram when it makes that relationship easier to see. Do not force every point into a small card, badge or review template.

## Concrete wording examples

These fictional examples illustrate wording choices, not required sections or measured product results. Keep accurate technical terms when the audience needs them, and explain what they mean in the situation.

| Vague wording | Concrete explanation |
|---|---|
| 提升导入状态的一致性。 | 文件校验失败，页面却仍显示导入成功。页面应显示失败，让用户知道要修正文件后重试。 |
| 增加两层校验，完善输入治理。 | 重复检查避免同一文件反复导入；必填检查避免缺少必要信息。两项检查分别解决不同问题。 |
| 过滤效果提升。 | 在同一组100条模拟记录中，重复提醒从20次降到8次，漏掉的有效提醒从1次增到3次。重复提醒减少了，但漏报有所增加。 |

For a formal report, write the finding directly; omit notes such as “可以直接同步下面这段”. For a requested review, explain the relevant changes and decisions; do not turn ordinary reports into review forms.

## Native disclosure markup

The CLI has no dedicated disclosure component. A fenced `html` block can contain a native `<details>` element. Let the CLI handle the page layout and theme; add no CSS or JavaScript for this interaction. Put ordinary HTML paragraphs inside the disclosure, since Markdown inside a raw HTML fence is not parsed.

````markdown
## Compare sales at a glance
The page can turn a table of product sales into a bar chart. For example, put each product beside its sales figure to see which sold more.

The chart compares recorded figures. Predicting how sales respond to a price change needs a separate model.

```html
<details>
<summary>Supported charts and how to supply the figures</summary>
<p>Use bars to compare items, a line to show change over time, and a pie to show shares of one whole.</p>
<p>Supply the labels and figures in the chart block. The CLI draws the chart.</p>
</details>
```
````

The example's main text contains the purpose, a concrete use and an important limit. The disclosure holds the extra instructions. It does not hide the reason for the conclusion.

Only when the user explicitly requests browser inspection, open and close the disclosure once, check keyboard operation, and check readability at a narrow width. Otherwise, do not run browser checks as part of rendering; read the CLI output for errors and warnings.
