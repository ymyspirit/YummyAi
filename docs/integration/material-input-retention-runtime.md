# 物料原填写的独立清除运行

2026-10-20，关联R03/R12/R28、B28/B33/B40/B51。复用已有开源BullMQ运行入口、Node定时器、数据库时钟、租户RLS和0140原物料提交，不新增队列、权限或执行框架。

## 固定的本地能力

从工作区根目录执行 `pnpm start:local:material-retention`。该入口只接受本地PostgreSQL、Redis和S3端点，拒绝额外参数，强制`WORKER_QUEUES=none`及`WORKER_SCHEDULERS=materialCommandRetentionScheduler`，继承的`all`不能扩大能力。它不运行账号初始化、迁移、其他调度器或业务消费者；生产部署仍须使用正式部署的资源和监管方式。

标准Worker继续核对数据库迁移、私有桶和Redis就绪，然后发出实际安装的`worker.lifecycle ready`。仅有进程PID或连通Redis不能代表就绪。普通API/Web可保持运行，旧业务队列保持停止，不为清除启动模型、店铺或物流执行。

## 到期、保留与失败

启动后执行首批，此后每60秒尝试下一批；上一批仍在运行时跳过本次定时触发。过期资格使用数据库`clock_timestamp()`，每租户每批最多100条并跳过其他事务正在锁定的记录。只有加密原填写被清除，待执行提交同时转为过期；成功/拒绝等终态、实际物料与库存流水、请求校验、制造依据及原回执保留。清除不能执行、取消或反转业务操作。

7天是原填写的到期时间；真正后台清除发生在到期后的成功维护批次。停机、数据库故障、锁定或超过单批容量会延后物理清除，需要恢复并观察后续批次，不能用一次ready或页面访问声称全部到期数据已清除。

每个实际批次输出`worker.maintenance`，包含固定调度器名、completed/deferred/failed以及租户、清除和失败计数。不输出租户ID、操作者、请求编号、填写、密文、连接参数或底层错误。重叠而未执行的触发不输出成功心跳，避免掩盖挂起批次。

## 生命周期与运维

清除定时器保持事件循环引用；`close()`取消下一轮并等待当前批次，之后由标准运行器关闭数据库。关闭使用终端Ctrl+C或受控宿主IPC `worker.shutdown`，以`stopped`与`clean:true`及进程终态核对；操作系统强杀不等于干净退出。恢复后从数据库继续扫描，不重新执行物料命令。

这是独立本地常驻入口，不自动注册Windows开机服务或生产集群。首批真实运行、周期及停止/重启见[原进度](../project-control/MATERIAL_RETENTION_PROGRESS_20261020.md)。后续普通142配对恢复和采用时已先干净关闭该进程，再以当前477c源码重新启动；实际ready、3257租户completed批次和32业务队列保持见[当前检查点](../project-control/INVENTORY_RECEIVING_PROGRESS_20261020.md)。全平台正式监管、其他执行器、异地灾备、工厂业务和完整Harness验收继续。

开源依据：[BullMQ停机](https://docs.bullmq.io/guide/workers/graceful-shutdown)、[Node 24定时器引用](https://nodejs.org/docs/latest-v24.x/api/timers.html#timeoutunref)。源码中的普通调度器和全功能Worker入口保留，不能把本入口的零消费者约束误套成所有Worker都不能执行任务。
