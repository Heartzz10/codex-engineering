# 第三方代码、工具与方法来源

本稿对应CE 0.5.14公开预审。CE自编部分采用MIT，见根目录LICENSE；不能把CE的根许可证当作所有第三方文件的许可证，也不能沿用早期“未复制第三方代码”的说明。

## 随包分发

| 来源 | 锁定范围 | 许可与保留方式 |
|---|---|---|
| Cursor plugins / Pstack | source-lock.json记录的提交b42effe0aa50f59c693d7e2924714e015e00bf7c；127项已核文本快照 | MIT；保留原LICENSE、版权和锁定字节。来源https://github.com/cursor/plugins；代码入口只采用四类协议，不表示完整移植或上游背书 |
| html-validate | 10.9.0浏览器打包工具 | MIT；保留vendor/ui-tools/licenses中的作者及许可。来源https://gitlab.com/html-validate/html-validate |
| axe-core | 4.13.0未改功能的浏览器检查引擎 | MPL-2.0；保留MPL全文和LICENSE-3RD-PARTY.txt。接收者可在https://github.com/dequelabs/axe-core/tree/v4.13.0取得对应Source Code Form；这是对应版本源代码获取入口，不是用CE根许可替换MPL |
| HTML打包的依赖 | ajv、@html-validate/stylish、@sidvind/better-ajv-errors、fast-deep-equal、fast-uri、json-schema-traverse、kleur、semver | 具体版本与对应许可见vendor/ui-tools/manifest.json及licenses原件；MIT、ISC、Apache-2.0等按各自文件保留。better-ajv-errors的完整Apache-2.0文本另附于vendor/ui-tools/licenses/Apache-2.0.txt；本机包未发现NOTICE，不编造其NOTICE |

构建使用esbuild，作为开发构建依赖不等同于将esbuild程序分发为CE运行时。Node.js是运行环境，其分发许可由Node.js项目提供。相关链接用于来源和代码获取，不表示作者认可CE。

## 仅作方法参考

按阶段核可行性、先证据后结论、复用有效检查和按需加载是成熟工程思想。Ant Design、IBM Carbon、W3C WCAG/APG、Apple/Android/Microsoft等资料按当前问题查阅；资料索引不表示整站代码已复制或已取得全平台认证。

公开包不会附带真实业务资料、供应商凭据、本机运行绑定或原始会话日志。可选Jev客户端不代表开通了外部服务或获得了业务资料外发授权。
