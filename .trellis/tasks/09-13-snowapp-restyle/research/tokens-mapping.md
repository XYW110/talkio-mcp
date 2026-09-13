# Token→CSS 变量映射与 FALLBACKS

## FALLBACKS（生成 CSS 时对缺失 token 的回退）
# snow-light 缺：surface.2→#F3F4F6(hover)、surface.3→#E5E7EB、surface.active→#E5E7EB、surface.chrome→#F8FAFC、selection.bg→#3B82F633
# snow-dark 缺：surface.active→#1A1A1A(surface.3)、surface.chrome→#111111(surface.solid)、selection.bg→#58A6FF47
# focus.ring 为 shadow 类型时取 layers[0].color 作为 --focus-ring 颜色（丢弃 spread）
# 现有 admin-web 变量映射：--canvas=bg.base、--surface-island=surface.base、--surface-island-strong=surface.solid、
#   --bg-hover=surface.hover、--bg-active=surface.active、--border-color=border.base、--text-*=text.*、
#   --accent-{green,red,blue,amber}=semantic.{success,danger,info,warning}.*、--on-solid=accent.contrast、
#   --island-shadow=island.shadow.base、--focus-ring=focus.ring、--selection-bg=selection.bg
# 新增变量：--surface-2、--surface-3、--surface-chrome、--border-strong、--accent-ink(=accent.base)、--gap-island
# 阴影 CSS 值合成规则：每层 `offsetX offsetY blur spread color[, inset]`，inset 层带 `inset` 前缀，多层逗号连接
