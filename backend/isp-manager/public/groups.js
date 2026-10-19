'use strict';
(() => {
    let busy = false;
    let deleting = null;

    async function loadGroups() {
        const groups = await api('groups');
        $('groups-list').replaceChildren(...groups.map(groupRow));
        if (!groups.length)
            $('groups-list').append(
                element(
                    'p',
                    'hint',
                    '还没有分组，可在上方新增。“未分组”用于存放尚未分组的节点，无需创建。',
                ),
            );
    }
    function groupRow(group) {
        const row = element('div', 'group-row');
        const details = element('div', 'group-info');
        details.append(
            element('strong', 'group-name', group.name),
            element(
                'span',
                'muted',
                `${group.nodeCount} 个节点 · ${group.shareCount} 个有效分组订阅`,
            ),
        );
        const rename = element('form', 'group-rename');
        const input = element('input');
        input.value = group.name;
        input.required = true;
        input.maxLength = 100;
        input.setAttribute('aria-label', `重命名分组：${group.name}`);
        const save = element('button', '', '保存名称');
        save.type = 'submit';
        const remove = element('button', 'danger-text', '删除');
        remove.type = 'button';
        remove.addEventListener('click', () => {
            deleting = group;
            $(
                'group-delete-description',
            ).textContent = `删除“${group.name}”后，其中 ${group.nodeCount} 个节点将保留并移至“未分组”，${group.shareCount} 个有效分组订阅将失效。`;
            $('group-delete-error').textContent = '';
            open('group-delete-dialog');
        });
        rename.append(input, save, remove);
        rename.addEventListener('submit', (event) => {
            event.preventDefault();
            mutate(async () => {
                const result = await api(
                    'groups',
                    { name: group.name, newName: input.value },
                    'PATCH',
                );
                if ($('group-filter').value === `g:${group.name}`) {
                    $('group-filter').append(
                        option(`g:${result.name}`, result.name),
                    );
                    $('group-filter').value = `g:${result.name}`;
                }
                toast('分组已重命名，关联订阅已同步更新');
            });
        });
        row.append(details, rename);
        return row;
    }
    function mutate(task, errorId = 'groups-error') {
        if (busy) return;
        busy = true;
        $('groups-controls').disabled = true;
        $('group-delete-confirm').disabled = true;
        return run(async () => {
            try {
                await task();
                // The delete dialog may already be closed; show refresh errors
                // in the manager that remains visible.
                await run(async () => {
                    await loadNodes();
                    await loadGroups();
                }, 'groups-error');
            } finally {
                busy = false;
                $('groups-controls').disabled = false;
                $('group-delete-confirm').disabled = false;
            }
        }, errorId);
    }
    $('groups-open').addEventListener('click', () => {
        $('groups-error').textContent = '';
        $('group-new-name').value = '';
        $('groups-list').replaceChildren(element('p', 'hint', '正在加载分组…'));
        open('groups-dialog');
        run(loadGroups, 'groups-error');
    });
    $('group-create-form').addEventListener('submit', (event) => {
        event.preventDefault();
        mutate(async () => {
            await api('groups', { name: $('group-new-name').value }, 'POST');
            $('group-new-name').value = '';
            toast('分组已新增，可在导入、编辑或移动节点时选择');
        });
    });
    $('group-delete-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!deleting) return;
        const group = deleting;
        mutate(async () => {
            await api('groups', { name: group.name }, 'DELETE');
            if ($('group-filter').value === `g:${group.name}`) {
                $('group-filter').value = '*';
                state.page = 1;
            }
            close('group-delete-dialog');
            deleting = null;
            toast('分组已删除，节点已移至未分组');
        }, 'group-delete-error');
    });
})();
