# 动态选择器管理 — 导入报告

- 目标位置: `apps/ts-api-gateway/data/selectors.json`
- 来源: `scripts/selectors-extracted.json` (141 条提取)
- 导入版本: `1.3.0`
- 更新时间: `2026-06-04T08:41:16.617327Z`
- 写入策略: 应用 `apps/ts-api-gateway/lib/selectorStore.ts` 的 `SelectorReader`
- 前端入口: `系统设置 → 自动化矩阵核心 → 动态选择器管理`

## 总览

- 源提取: **141** 条
- 导入: **110** 条
- 过滤删除: **31** 条
- 跳过（无 primary）: **0** 条

## 平台 × 类别分布

| 平台 | menus | buttons | regions | textboxes | 合计 |
|---|---|---|---|---|---|
| 抖音 | 25 | 11 | 4 | 3 | 43 |
| 快手 | 24 | 14 | 4 | 1 | 43 |
| 小红书 | 11 | 9 | 2 | 2 | 24 |

**总计: 110 条**

## 已导入选择器

### 抖音  (douyin)

#### menus  (25)

| key | type | primary | fallbacks |
|---|---|---|---|
| `menu_home` | role | `getByRole("menuitem", name="首页")` | #douyin-creator-master-menu-nav-home:visible / getByText("首页", exact=True) |
| `menu_activity_management` | role | `getByRole("menuitem", name="活动管理")` | #douyin-creator-master-menu-nav-activity_management:visible / getByText("活动管理", exact=True) |
| `menu_content` | role | `getByRole("menuitem", name="内容管理")` | #douyin-creator-master-menu-nav-content:visible / getByText("内容管理", exact=True) |
| `menu_work_manage` | role | `getByRole("menuitem", name="作品管理")` | #douyin-creator-master-menu-nav-work_manage:visible / getByText("作品管理", exact=True) |
| `menu_collection_manage` | role | `getByRole("menuitem", name="合集管理")` | #douyin-creator-master-menu-nav-collection_manage:visible / getByText("合集管理", exact=True) |
| `menu_cooperate_center` | role | `getByRole("menuitem", name="共创中心")` | #douyin-creator-master-menu-nav-cooperate_center:visible / getByText("共创中心", exact=True) |
| `menu_right_manage` | role | `getByRole("menuitem", name="原创保护中心")` | #douyin-creator-master-menu-nav-right_manage:visible / getByText("原创保护中心", exact=True) |
| `menu_interaction` | role | `getByRole("menuitem", name="互动管理")` | #douyin-creator-master-menu-nav-interaction:visible / getByText("互动管理", exact=True) |
| `menu_follow_manage` | role | `getByRole("menuitem", name="关注管理")` | #douyin-creator-master-menu-nav-follow_manage:visible / getByText("关注管理", exact=True) |
| `menu_fans_manage` | role | `getByRole("menuitem", name="粉丝管理")` | #douyin-creator-master-menu-nav-fans_manage:visible / getByText("粉丝管理", exact=True) |
| `menu_comment_manage_new` | role | `getByRole("menuitem", name="评论管理")` | #douyin-creator-master-menu-nav-comment_manage_new:visible / getByText("评论管理", exact=True) |
| `menu_danmaku_manage` | role | `getByRole("menuitem", name="弹幕管理")` | #douyin-creator-master-menu-nav-danmaku_manage:visible / getByText("弹幕管理", exact=True) |
| `menu_message_manage` | role | `getByRole("menuitem", name="私信管理")` | #douyin-creator-master-menu-nav-message_manage:visible / getByText("私信管理", exact=True) |
| `menu_data-center` | role | `getByRole("menuitem", name="数据中心")` | #douyin-creator-master-menu-nav-data-center:visible / getByText("数据中心", exact=True) |
| `menu_business_analysis` | role | `getByRole("menuitem", name="账号总览")` | #douyin-creator-master-menu-nav-business_analysis:visible / getByText("账号总览", exact=True) |
| `menu_content_analysis` | role | `getByRole("menuitem", name="作品分析")` | #douyin-creator-master-menu-nav-content_analysis:visible / getByText("作品分析", exact=True) |
| `menu_fans_characteristic` | role | `getByRole("menuitem", name="粉丝分析")` | #douyin-creator-master-menu-nav-fans_characteristic:visible / getByText("粉丝分析", exact=True) |
| `menu_following` | role | `getByRole("menuitem", name="重点关心")` | #douyin-creator-master-menu-nav-following:visible / getByText("重点关心", exact=True) |
| `menu_cash_square` | role | `getByRole("menuitem", name="变现广场")` | #douyin-creator-master-menu-nav-cash_square:visible / getByText("变现广场", exact=True) |
| `menu_my_task` | role | `getByRole("menuitem", name="我的任务")` | #douyin-creator-master-menu-nav-my_task:visible / getByText("我的任务", exact=True) |
| `menu_my_income` | role | `getByRole("menuitem", name="我的收入")` | #douyin-creator-master-menu-nav-my_income:visible / getByText("我的收入", exact=True) |
| `menu_create_content` | role | `getByRole("menuitem", name="创作灵感")` | #douyin-creator-master-menu-nav-create_content:visible / getByText("创作灵感", exact=True) |
| `menu_study_center` | role | `getByRole("menuitem", name="学习中心")` | #douyin-creator-master-menu-nav-study_center:visible / getByText("学习中心", exact=True) |
| `menu_creator_count` | role | `getByRole("menuitem", name="抖音指数")` | #douyin-creator-master-menu-nav-creator_count:visible / getByText("抖音指数", exact=True) |
| `menu_publish_hd` | role | `getByRole("button", name="高清发布")` | .douyin-creator-master-button:visible / getByText("高清发布", exact=True) |

#### buttons  (11)

| key | type | primary | fallbacks |
|---|---|---|---|
| `btn_upload_video` | role | `getByRole("button", name="上传视频")` | .semi-button:visible / getByText("上传视频", exact=True) |
| `btn_publish_submit` | role | `getByRole("button", name="发布")` | .button-dhlUZE:visible / getByText("发布", exact=True) |
| `btn_publish_save_draft` | role | `getByRole("button", name="暂存离开")` | .button-dhlUZE:visible / getByText("暂存离开", exact=True) |
| `btn_tabs_works_live` | role | `getByRole("tablist", name="投稿作品 直播场次")` | .douyin-creator-pc-tabs-bar:visible / getByText("投稿作品 直播场次", exact=True) |
| `btn_tab_投稿作品` | role | `getByRole("tab", name="投稿作品")` | #semiTab1:visible / getByText("投稿作品", exact=True) |
| `btn_tab_直播场次` | role | `getByRole("tab", name="直播场次")` | #semiTab2:visible / getByText("直播场次", exact=True) |
| `btn_radio_投稿分析` | text | `getByText("投稿分析", exact=True)` | #addon-llvc3tw:visible / .douyin-creator-pc-radio-addon-buttonRadio:visible |
| `btn_radio_投稿列表` | text | `getByText("投稿列表", exact=True)` | #addon-b6jeqp9:visible / .douyin-creator-pc-radio-addon-buttonRadio:visible |
| `btn_works_导出数据` | role | `getByRole("button", name="导出数据")` | .douyin-creator-pc-button:visible / getByText("导出数据", exact=True) |
| `btn_works_刷新数据` | role | `getByRole("button", name="刷新数据")` | .douyin-creator-pc-button:visible / getByText("刷新数据", exact=True) |
| `btn_select_works` | role | `getByRole("button", name="选择作品")` | .douyin-creator-interactive-button:visible / getByText("选择作品", exact=True) |

#### regions  (4)

| key | type | primary | fallbacks |
|---|---|---|---|
| `region_upload_zone` | role | `getByRole("presentation")` | .container-drag-VAfIfu:visible / xpath=//div/div[2]/div/div[1]/div/div/div[3] |
| `region_work_list_item` | css | `xpath=//*[@id="root"]/div/div` | xpath=//div[text()="作品管理"]/ancestor::div[contains(@class, "card-container")][1] |
| `region_works_analysis_scroll` | role | `getByRole("grid")` | .douyin-creator-pc-table:visible / xpath=//div[@id='semiTabPanel1']/div/div/div[3]/div/div/div/div[2]/div/div/div/div/div/div/div/div/div/div/table |
| `region_works_pick_scroll` | css | `xpath=/html/body/div[14]/div/div[2]/div/div[2]` | xpath=//div[contains(@class, "douyin-creator-interactive-sidesheet-body")] |

#### textboxes  (3)

| key | type | primary | fallbacks |
|---|---|---|---|
| `tb_title` | css | `input[placeholder*="填写作品标题"]:visible` | input[placeholder*="填写作品标题"] / xpath=//input[contains(@placeholder, "填写作品标题")] |
| `tb_description` | css | `div[data-placeholder*="作品简介"]:visible` | div[data-placeholder*="作品简介"] / xpath=//div[contains(@data-placeholder, "作品简介")] |
| `tb_text` | role | `getByRole("textbox")` | .semi-input:visible / getByPlaceholder("请输入视频售价") |

### 快手  (kuaishou)

#### menus  (24)

| key | type | primary | fallbacks |
|---|---|---|---|
| `menu_首页` | role | `getByRole("menuitem", name="首页")` | .el-menu-item:visible / getByText("首页", exact=True) |
| `menu_内容管理` | text | `getByText("内容管理", exact=True)` | .el-submenu__title:visible / xpath=//ul/li[2]/div |
| `menu_作品管理` | role | `getByRole("menuitem", name="作品管理")` | .el-menu-item:visible / getByText("作品管理", exact=True) |
| `menu_合集管理` | role | `getByRole("menuitem", name="合集管理")` | .el-menu-item:visible / getByText("合集管理", exact=True) |
| `menu_创建合集` | role | `getByRole("menuitem", name="创建合集")` | .el-menu-item:visible / getByText("创建合集", exact=True) |
| `menu_互动管理` | text | `getByText("互动管理", exact=True)` | .el-submenu__title:visible / xpath=//ul/li[3]/div |
| `menu_评论管理` | role | `getByRole("menuitem", name="评论管理")` | .el-menu-item:visible / getByText("评论管理", exact=True) |
| `menu_数据中心` | text | `getByText("数据中心", exact=True)` | .el-submenu__title:visible / xpath=//ul/li[4]/div |
| `menu_数据概览` | role | `getByRole("menuitem", name="数据概览")` | .el-menu-item:visible / getByText("数据概览", exact=True) |
| `menu_作品分析` | role | `getByRole("menuitem", name="作品分析")` | .el-menu-item:visible / getByText("作品分析", exact=True) |
| `menu_直播数据` | role | `getByRole("menuitem", name="直播数据")` | .el-menu-item:visible / getByText("直播数据", exact=True) |
| `menu_粉丝分析` | role | `getByRole("menuitem", name="粉丝分析")` | .el-menu-item:visible / getByText("粉丝分析", exact=True) |
| `menu_成长中心` | role | `getByRole("menuitem", name="成长中心")` | .el-menu-item:visible / getByText("成长中心", exact=True) |
| `menu_创作服务` | text | `getByText("创作服务", exact=True)` | .el-submenu__title:visible / xpath=//ul/li[6]/div |
| `menu_创作灵感` | role | `getByRole("menuitem", name="创作灵感")` | .el-menu-item:visible / getByText("创作灵感", exact=True) |
| `menu_我的灵感` | role | `getByRole("menuitem", name="我的灵感")` | .el-menu-item:visible / getByText("我的灵感", exact=True) |
| `menu_活动中心` | role | `getByRole("menuitem", name="活动中心")` | .el-menu-item:visible / getByText("活动中心", exact=True) |
| `menu_热点榜单` | role | `getByRole("menuitem", name="热点榜单")` | .el-menu-item:visible / getByText("热点榜单", exact=True) |
| `menu_创作学院` | role | `getByRole("menuitem", name="创作学院")` | .el-menu-item:visible / getByText("创作学院", exact=True) |
| `menu_其他服务` | text | `getByText("其他服务", exact=True)` | .el-submenu__title:visible / xpath=//ul/li[7]/div |
| `menu_音乐人` | role | `getByRole("menuitem", name="音乐人")` | .el-menu-item:visible / getByText("音乐人", exact=True) |
| `menu_作品推广` | role | `getByRole("menuitem", name="作品推广")` | .el-menu-item:visible / getByText("作品推广", exact=True) |
| `menu_推广资源管理` | role | `getByRole("menuitem", name="推广资源管理")` | .el-menu-item:visible / getByText("推广资源管理", exact=True) |
| `menu_创建直播` | role | `getByRole("menuitem", name="创建直播")` | .el-menu-item:visible / getByText("创建直播", exact=True) |

#### buttons  (14)

| key | type | primary | fallbacks |
|---|---|---|---|
| `tab_上传视频` | role | `getByRole("tab", name="上传视频")` | #rc-tabs-0-tab-1:visible / getByText("上传视频", exact=True) |
| `tab_上传图文` | role | `getByRole("tab", name="上传图文")` | #rc-tabs-0-tab-2:visible / getByText("上传图文", exact=True) |
| `tab_上传全景视频` | role | `getByRole("tab", name="上传全景视频")` | #rc-tabs-0-tab-3:visible / getByText("上传全景视频", exact=True) |
| `btn_继续编辑` | role | `getByRole("button", name="继续编辑")` | xpath=//div[@id='joyride-wrapper']/main/section/div[1]/div[2]/button[1] / getByText("继续编辑", exact=True) |
| `btn_放弃` | role | `getByRole("button", name="放弃")` | xpath=//div[@id='joyride-wrapper']/main/section/div[1]/div[2]/button[2] / getByText("放弃", exact=True) |
| `btn_上传视频` | role | `getByRole("button", name="上传视频")` | xpath=//div[@id='joyride-wrapper']/main/section/div[2]/div[1]/div[2]/button / getByText("上传视频", exact=True) |
| `btn_立即体验` | role | `getByRole("button", name="立即体验")` | xpath=//div[@id='joyride-wrapper']/main/div/button / getByText("立即体验", exact=True) |
| `btn_ai_assistant` | text | `getByText("智能文案", exact=True)` | #ai-button:visible / xpath=//div[@id='ai-button'] |
| `tab_全部作品` | role | `getByRole("tab", name="全部作品")` | #tab-0:visible / getByText("全部作品", exact=True) |
| `tab_已发布` | role | `getByRole("tab", name="已发布")` | #tab-1:visible / getByText("已发布", exact=True) |
| `tab_待发布` | role | `getByRole("tab", name="待发布")` | #tab-2:visible / getByText("待发布", exact=True) |
| `tab_未通过` | role | `getByRole("tab", name="未通过")` | #tab-3:visible / getByText("未通过", exact=True) |
| `btn_video_pick_item` | css | `.video-item:visible` | xpath=//div/div/div[1] |
| `btn_select_videos` | role | `getByRole("button", name="选择视频")` | .el-button:visible / getByText("选择视频", exact=True) |

#### regions  (4)

| key | type | primary | fallbacks |
|---|---|---|---|
| `region_work_list_scroll` | css | `.main-container-infinite-list:visible` | xpath=//div/div/div[3] |
| `region_pane_pane-0` | role | `getByRole("tabpanel")` | #pane-0:visible / .el-tab-pane:visible |
| `region_video_pick_scroll` | text | `getByText("作品列表", exact=True)` | .video-list__header:visible / xpath=//div/header |
| `region_works_analysis_scroll` | css | `.statistics_article_list:visible` | xpath=//div |

#### textboxes  (1)

| key | type | primary | fallbacks |
|---|---|---|---|
| `tb_description` | placeholder | `getByPlaceholder("作品描述不会写？试试智能文案")` | #work-description-edit:visible / xpath=//div[@id='work-description-edit'] |

### 小红书  (xiaohongshu)

#### menus  (11)

| key | type | primary | fallbacks |
|---|---|---|---|
| `menu_publish` | text | `getByText("发布笔记", exact=True)` | .btn-wrapper:visible / xpath=//div/div[1]/div |
| `menu_首页` | text | `getByText("首页", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[1] |
| `menu_笔记管理` | text | `getByText("笔记管理", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[2] |
| `menu_数据看板` | text | `getByText("数据看板", exact=True)` | .d-sub-menu:visible / xpath=//div/div[2]/div[1]/div[3] |
| `menu_账号概览` | text | `getByText("账号概览", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[1] |
| `menu_内容分析` | text | `getByText("内容分析", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[2] |
| `menu_粉丝数据` | text | `getByText("粉丝数据", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[3] |
| `menu_活动中心` | text | `getByText("活动中心", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[4] |
| `menu_笔记灵感` | text | `getByText("笔记灵感", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[5] |
| `menu_创作学院` | text | `getByText("创作学院", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[6] |
| `menu_创作百科` | text | `getByText("创作百科", exact=True)` | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[7] |

#### buttons  (9)

| key | type | primary | fallbacks |
|---|---|---|---|
| `btn_upload_video` | role | `getByRole("button", name="上传视频")` | .d-button:visible / getByText("上传视频", exact=True) |
| `btn_topic` | role | `getByRole("button", name="话题")` | #topicBtn:visible / getByText("话题", exact=True) |
| `btn_用户` | role | `getByRole("button", name="用户")` | #userBtn:visible / getByText("用户", exact=True) |
| `btn_表情` | role | `getByRole("button", name="表情")` | #emoticonsBtn:visible / getByText("表情", exact=True) |
| `select_添加内容类型声明` | text | `getByText("添加内容类型声明", exact=True)` | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[2]/div[4]/div[1] |
| `select_添加地点` | text | `getByText("添加地点", exact=True)` | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[4]/div[1]/div/div |
| `select_选择群聊` | text | `getByText("选择群聊", exact=True)` | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[4]/div[2]/div/div |
| `select_公开可见` | text | `getByText("公开可见", exact=True)` | .d-select-wrapper:visible / xpath=//div/div[1]/div[6]/div[2]/div[1]/div/div |
| `btn_导出数据` | role | `getByRole("button", name="导出数据")` | .d-button:visible / getByText("导出数据", exact=True) |

#### regions  (2)

| key | type | primary | fallbacks |
|---|---|---|---|
| `region_upload_zone` | css | `.upload-container:visible` | xpath=//div |
| `region_data_board_scroll` | css | `.d-table-v2:visible` | xpath=//div/div/div[2] |

#### textboxes  (2)

| key | type | primary | fallbacks |
|---|---|---|---|
| `tb_title` | role | `getByRole("textbox")` | .d-text:visible / getByPlaceholder("填写标题会有更多赞哦") |
| `tb_description` | role | `getByRole("textbox")` | .tiptap:visible / xpath=//div/div[1]/div[3]/div/div[2]/div[1]/div/div |

## 已删除（31 条）

每条删除都附带明确理由；如需恢复，从 `selectors-extracted.json` 重新提取即可。

| platform | category | key | 理由 |
|---|---|---|---|
| `douyin` | `menus` | `menu_cash` | primary 把 '变现中心/广场/任务/收入' 4 个菜单拼到 name 里，role+name 不会命中；唯一可用的 fallback 是 getByText('变现中心')，已被 menu_cash_square 覆盖 |
| `douyin` | `menus` | `menu_create` | primary 把 '创作中心/灵感/学习/指数' 4 个菜单拼到 name 里，同上失效 |
| `douyin` | `textboxes` | `tb_description_editor` | 与 tb_description 完全重复（同 .zone-container 描述编辑框，仅 key 别名） |
| `douyin` | `textboxes` | `text_works_pick_title` | primary 写死了具体视频标题 '打到我 #loft复式 #效果图'（录制时的实例数据），结构性 0 价值 |
| `kuaishou` | `menus` | `menu_sub_作品管理` | 与 menu_作品管理 选择器完全相同（DOM 片段里菜单出现两次，sub_* 是机械复制） |
| `kuaishou` | `menus` | `menu_sub_合集管理` | 与 menu_合集管理 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_创建合集` | 与 menu_创建合集 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_评论管理` | 与 menu_评论管理 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_数据概览` | 与 menu_数据概览 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_作品分析` | 与 menu_作品分析 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_直播数据` | 与 menu_直播数据 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_粉丝分析` | 与 menu_粉丝分析 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_创作灵感` | 与 menu_创作灵感 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_我的灵感` | 与 menu_我的灵感 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_活动中心` | 与 menu_活动中心 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_热点榜单` | 与 menu_热点榜单 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_创作学院` | 与 menu_创作学院 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_音乐人` | 与 menu_音乐人 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_作品推广` | 与 menu_作品推广 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_推广资源管理` | 与 menu_推广资源管理 选择器完全相同 |
| `kuaishou` | `menus` | `menu_sub_创建直播` | 与 menu_创建直播 选择器完全相同 |
| `kuaishou` | `regions` | `region_upload_zone` | primary 是 //div[@id='joyride-wrapper']/main/section——整个页面外壳，不是拖拽 widget；具体上传入口已被 btn_upload_video 覆盖 |
| `kuaishou` | `regions` | `region_pane_pane-1` | 与 region_pane_pane-0 同一结构（getByRole('tabpanel')+ #pane-N），仅 index 不同；只需 pane-0 |
| `kuaishou` | `regions` | `region_pane_pane-2` | 同上，仅 index 不同 |
| `kuaishou` | `regions` | `region_pane_pane-3` | 同上，仅 index 不同 |
| `xiaohongshu` | `menus` | `menu_sub_账号概览` | 与 menu_账号概览 选择器完全相同（.d-menu-item:visible） |
| `xiaohongshu` | `menus` | `menu_sub_内容分析` | 与 menu_内容分析 选择器完全相同 |
| `xiaohongshu` | `menus` | `menu_sub_粉丝数据` | 与 menu_粉丝数据 选择器完全相同 |
| `xiaohongshu` | `regions` | `region_note_list_scroll` | primary 用了 '正在加载中...' 这种瞬时文字，DOM 加载完成后即消失；应改用 .bottom-loading:visible 容器或 #notes-request |
| `xiaohongshu` | `regions` | `form_笔记题材` | 只是 <label> 文本，不是可交互控件；自动化用不上 |
| `xiaohongshu` | `regions` | `form_笔记首发时间` | 同上，只是 label 文本 |

