# 工厂本人清点

本规格对应d8b4f261早先的未验收可选草稿。2026-10-21用户确认工厂两态/Excel-CSV流程后，本能力退出正常页面，controller未注册，不再作为必经步骤。当前业务见[工厂状态导入](factory-erp-status-import.md)，原生产数量规则见[实际数量契约](production-physical-quantities.md)。本页路径仅为草稿设计，不代表可调用或业务放行。

GET /v1/factory-portal/work-items/:id/quantity 只返回当前本人任务、整张原生产版本数量、已核准四桶/停做量、不可逆比较值及本人报告分页。GET相同前缀的/quantity/access用于请求后复核当前任务授权和来源。POST /quantity/reports登记本人清点；不接收内部生产ID、附件ID、库存或ERP数量依据。原工厂个人OIDC与当前membership、grant、assignment共同限定授权。

quantity/access.canReport仅表示本人当前Read+Respond任务权限。workspace.access.canReport还须满足可提交依据。taskFingerprint固定任务/接受/文件与版本等来源，不随运营核准后数量projection变化；basis.fingerprint变化只阻断新的原请求，不能阻断合法成功回执的读取。会话contextAuthority为opaque比较值，不能代替当前权限验证。

四桶为未投入、在制、完成、报废，可逐项未知。只有已知量可校验其上界；运营原review要求全已知及原数量守恒，并遵循已有实物下界、各原资源池停做净量与审计规则。报告按完整生产版本清点，不能把不同文件任务数量相加。质量暂停或取消申请中仍可清点，取消终态及私有资料、审核、原版本等失效会阻断新的报告。

factory_quantity_report_origins一对一记录原production_quantity_reports的本人来源、原assignment/accepted回执、文件/制造checksum、原文及fullxid。原报告内部key为factory-quantity:加原UUID，factory侧UUID作为同租户唯一请求身份。原报告、来源与production.quantity.report_recorded、factory_portal.quantity_reported双审计同事务；来源不得改删，也不回填旧报告。

前端未知结果保留本页本人/任务范围原正文与原键，503和关闭任务不自动改写；重新登录跨会话持久原文恢复尚不在本批承诺。写后由BFF复核当前会话和任务来源，界面按本人上下文和选中任务阻止过期响应重新显示私有资料。
