# 抖音/快手/小红书 平台选择器提取报告

- 共 141 条选择器（人工覆盖后）
- 输出 JSON: `scripts/selectors-extracted.json`
- 来源：`extract_selectors.py` + `apply_overrides.py`

## 抖音  (douyin)

### menus  (27)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| menu_home | `getByRole("menuitem", name="首页")` | role | getByText("首页", exact=True) / #douyin-creator-master-menu-nav-home:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_activity_management | `getByRole("menuitem", name="活动管理")` | role | getByText("活动管理", exact=True) / #douyin-creator-master-menu-nav-activity_management:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_content | `getByRole("menuitem", name="内容管理")` | role | getByText("内容管理", exact=True) / #douyin-creator-master-menu-nav-content:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_work_manage | `getByRole("menuitem", name="作品管理")` | role | getByText("作品管理", exact=True) / #douyin-creator-master-menu-nav-work_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_collection_manage | `getByRole("menuitem", name="合集管理")` | role | getByText("合集管理", exact=True) / #douyin-creator-master-menu-nav-collection_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_cooperate_center | `getByRole("menuitem", name="共创中心")` | role | getByText("共创中心", exact=True) / #douyin-creator-master-menu-nav-cooperate_center:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_right_manage | `getByRole("menuitem", name="原创保护中心")` | role | getByText("原创保护中心", exact=True) / #douyin-creator-master-menu-nav-right_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_interaction | `getByRole("menuitem", name="互动管理")` | role | getByText("互动管理", exact=True) / #douyin-creator-master-menu-nav-interaction:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_follow_manage | `getByRole("menuitem", name="关注管理")` | role | getByText("关注管理", exact=True) / #douyin-creator-master-menu-nav-follow_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_fans_manage | `getByRole("menuitem", name="粉丝管理")` | role | getByText("粉丝管理", exact=True) / #douyin-creator-master-menu-nav-fans_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_comment_manage_new | `getByRole("menuitem", name="评论管理")` | role | getByText("评论管理", exact=True) / #douyin-creator-master-menu-nav-comment_manage_new:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_danmaku_manage | `getByRole("menuitem", name="弹幕管理")` | role | getByText("弹幕管理", exact=True) / #douyin-creator-master-menu-nav-danmaku_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_message_manage | `getByRole("menuitem", name="私信管理")` | role | getByText("私信管理", exact=True) / #douyin-creator-master-menu-nav-message_manage:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_data-center | `getByRole("menuitem", name="数据中心")` | role | getByText("数据中心", exact=True) / #douyin-creator-master-menu-nav-data-center:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_business_analysis | `getByRole("menuitem", name="账号总览")` | role | getByText("账号总览", exact=True) / #douyin-creator-master-menu-nav-business_analysis:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_content_analysis | `getByRole("menuitem", name="作品分析")` | role | getByText("作品分析", exact=True) / #douyin-creator-master-menu-nav-content_analysis:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_fans_characteristic | `getByRole("menuitem", name="粉丝分析")` | role | getByText("粉丝分析", exact=True) / #douyin-creator-master-menu-nav-fans_characteristic:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_following | `getByRole("menuitem", name="重点关心")` | role | getByText("重点关心", exact=True) / #douyin-creator-master-menu-nav-following:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_cash | `getByRole("menuitem", name="变现中心 变现广场 我的任务 我的收入")` | role | getByText("变现中心", exact=True) / #douyin-creator-master-menu-nav-cash:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_cash_square | `getByRole("menuitem", name="变现广场")` | role | getByText("变现广场", exact=True) / #douyin-creator-master-menu-nav-cash_square:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_my_task | `getByRole("menuitem", name="我的任务")` | role | getByText("我的任务", exact=True) / #douyin-creator-master-menu-nav-my_task:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_my_income | `getByRole("menuitem", name="我的收入")` | role | getByText("我的收入", exact=True) / #douyin-creator-master-menu-nav-my_income:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_create | `getByRole("menuitem", name="创作中心 创作灵感 学习中心 抖音指数")` | role | getByText("创作中心", exact=True) / #douyin-creator-master-menu-nav-create:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_create_content | `getByRole("menuitem", name="创作灵感")` | role | getByText("创作灵感", exact=True) / #douyin-creator-master-menu-nav-create_content:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_study_center | `getByRole("menuitem", name="学习中心")` | role | getByText("学习中心", exact=True) / #douyin-creator-master-menu-nav-study_center:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_creator_count | `getByRole("menuitem", name="抖音指数")` | role | getByText("抖音指数", exact=True) / #douyin-creator-master-menu-nav-creator_count:visible | {"page": "menu", "checks": [["#douyin-creator-master-menu-na… |
| menu_publish_hd | `getByRole("button", name="高清发布")` | role | getByText("高清发布", exact=True) / .douyin-creator-master-button:visible | {"page": "menu", "checks": [[".douyin-creator-master-button:… |

### buttons  (11)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| btn_upload_video | `getByRole("button", name="上传视频")` | role | getByText("上传视频", exact=True) / .semi-button:visible | {"page": "publish", "checks": [[".semi-button:visible", 1, "… |
| btn_publish_submit | `getByRole("button", name="发布")` | role | getByText("发布", exact=True) / .button-dhlUZE:visible | {"page": "publish_after", "checks": [[".button-dhlUZE:visibl… |
| btn_publish_save_draft | `getByRole("button", name="暂存离开")` | role | getByText("暂存离开", exact=True) / .button-dhlUZE:visible | {"page": "publish_after", "checks": [[".button-dhlUZE:visibl… |
| btn_tabs_works_live | `getByRole("tablist", name="投稿作品 直播场次")` | role | getByText("投稿作品 直播场次", exact=True) / .douyin-creator-pc-tabs-bar:visible | {"page": "works_analysis", "checks": [[".douyin-creator-pc-t… |
| btn_tab_投稿作品 | `getByRole("tab", name="投稿作品")` | role | getByText("投稿作品", exact=True) / #semiTab1:visible | {"page": "works_analysis", "checks": [["#semiTab1:visible", … |
| btn_tab_直播场次 | `getByRole("tab", name="直播场次")` | role | getByText("直播场次", exact=True) / #semiTab2:visible | {"page": "works_analysis", "checks": [["#semiTab2:visible", … |
| btn_radio_投稿分析 | `getByText("投稿分析", exact=True)` | text | #addon-llvc3tw:visible / .douyin-creator-pc-radio-addon-buttonRadio:visible | {"page": "works_analysis", "checks": [["#addon-llvc3tw:visib… |
| btn_radio_投稿列表 | `getByText("投稿列表", exact=True)` | text | #addon-b6jeqp9:visible / .douyin-creator-pc-radio-addon-buttonRadio:visible | {"page": "works_analysis", "checks": [["#addon-b6jeqp9:visib… |
| btn_works_导出数据 | `getByRole("button", name="导出数据")` | role | getByText("导出数据", exact=True) / .douyin-creator-pc-button:visible | {"page": "works_analysis", "checks": [[".douyin-creator-pc-b… |
| btn_works_刷新数据 | `getByRole("button", name="刷新数据")` | role | getByText("刷新数据", exact=True) / .douyin-creator-pc-button:visible | {"page": "works_analysis", "checks": [[".douyin-creator-pc-b… |
| btn_select_works | `getByRole("button", name="选择作品")` | role | getByText("选择作品", exact=True) / .douyin-creator-interactive-button:visible | {"page": "comment_manage", "checks": [[".douyin-creator-inte… |

### regions  (4)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| region_upload_zone | `getByRole("presentation")` | role | .container-drag-VAfIfu:visible / xpath=//div/div[2]/div/div[1]/div/div/div[3] | {"page": "publish", "checks": [[".container-drag-VAfIfu:visi… |
| region_work_list_item | `xpath=//*[@id="root"]/div/div` | xpath | xpath=//div[text()="作品管理"]/ancestor::div[contains(@class, "card-container")][1] | {"page": "work_manage", "source": "manual override (user-ver… |
| region_works_analysis_scroll | `getByRole("grid")` | role | .douyin-creator-pc-table:visible / xpath=//div[@id='semiTabPanel1']/div/div/div[3]/div/div/div/div[2]/div/div/div/div/div/div/div/div/div/div/table | {"page": "works_analysis", "checks": [[".douyin-creator-pc-t… |
| region_works_pick_scroll | `xpath=/html/body/div[14]/div/div[2]/div/div[2]` | xpath | xpath=//div[contains(@class, "douyin-creator-interactive-sidesheet-body")] | {"page": "select_works", "source": "manual override (user-ve… |

### textboxes  (5)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| tb_title | `input[placeholder*="填写作品标题"]:visible` | css | xpath=//input[contains(@placeholder, "填写作品标题")] | {"page": "publish_after", "source": "manual override (user-v… |
| tb_description | `div[data-placeholder*="作品简介"]:visible` | css | xpath=//div[contains(@data-placeholder, "作品简介")] | {"page": "publish_after", "source": "manual override (user-v… |
| tb_text | `getByRole("textbox")` | role | getByPlaceholder("请输入视频售价") / .semi-input:visible | {"page": "publish_after", "checks": [[".semi-input:visible",… |
| tb_description_editor | `getByText("​", exact=True)` | text | .zone-container:visible / xpath=//div/div[1]/div/div[1]/div[2]/div[1]/div[1]/div[2]/div/div/div/div/div[2]/div | {"page": "publish_after", "checks": [[".zone-container:visib… |
| text_works_pick_title | `getByText("打到我 #loft复式 #效果图", exact=True)` | text | .title-LUOP3b:visible / xpath=//div/div/div/div[1]/div/ul/div[1]/div[1]/div[1] | {"page": "select_works", "checks": [[".title-LUOP3b:visible"… |

## 快手  (kuaishou)

### menus  (41)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| menu_首页 | `getByRole("menuitem", name="首页")` | role | getByText("首页", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_内容管理 | `getByText("内容管理", exact=True)` | text | .el-submenu__title:visible / xpath=//ul/li[2]/div | {"page": "menu", "checks": [[".el-submenu__title:visible", 5… |
| menu_作品管理 | `getByRole("menuitem", name="作品管理")` | role | getByText("作品管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_合集管理 | `getByRole("menuitem", name="合集管理")` | role | getByText("合集管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_创建合集 | `getByRole("menuitem", name="创建合集")` | role | getByText("创建合集", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_互动管理 | `getByText("互动管理", exact=True)` | text | .el-submenu__title:visible / xpath=//ul/li[3]/div | {"page": "menu", "checks": [[".el-submenu__title:visible", 5… |
| menu_评论管理 | `getByRole("menuitem", name="评论管理")` | role | getByText("评论管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_数据中心 | `getByText("数据中心", exact=True)` | text | .el-submenu__title:visible / xpath=//ul/li[4]/div | {"page": "menu", "checks": [[".el-submenu__title:visible", 5… |
| menu_数据概览 | `getByRole("menuitem", name="数据概览")` | role | getByText("数据概览", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_作品分析 | `getByRole("menuitem", name="作品分析")` | role | getByText("作品分析", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_直播数据 | `getByRole("menuitem", name="直播数据")` | role | getByText("直播数据", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_粉丝分析 | `getByRole("menuitem", name="粉丝分析")` | role | getByText("粉丝分析", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_成长中心 | `getByRole("menuitem", name="成长中心")` | role | getByText("成长中心", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_创作服务 | `getByText("创作服务", exact=True)` | text | .el-submenu__title:visible / xpath=//ul/li[6]/div | {"page": "menu", "checks": [[".el-submenu__title:visible", 5… |
| menu_创作灵感 | `getByRole("menuitem", name="创作灵感")` | role | getByText("创作灵感", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_我的灵感 | `getByRole("menuitem", name="我的灵感")` | role | getByText("我的灵感", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_活动中心 | `getByRole("menuitem", name="活动中心")` | role | getByText("活动中心", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_热点榜单 | `getByRole("menuitem", name="热点榜单")` | role | getByText("热点榜单", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_创作学院 | `getByRole("menuitem", name="创作学院")` | role | getByText("创作学院", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_其他服务 | `getByText("其他服务", exact=True)` | text | .el-submenu__title:visible / xpath=//ul/li[7]/div | {"page": "menu", "checks": [[".el-submenu__title:visible", 5… |
| menu_音乐人 | `getByRole("menuitem", name="音乐人")` | role | getByText("音乐人", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_作品推广 | `getByRole("menuitem", name="作品推广")` | role | getByText("作品推广", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_推广资源管理 | `getByRole("menuitem", name="推广资源管理")` | role | getByText("推广资源管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_创建直播 | `getByRole("menuitem", name="创建直播")` | role | getByText("创建直播", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_作品管理 | `getByRole("menuitem", name="作品管理")` | role | getByText("作品管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_合集管理 | `getByRole("menuitem", name="合集管理")` | role | getByText("合集管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_创建合集 | `getByRole("menuitem", name="创建合集")` | role | getByText("创建合集", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_评论管理 | `getByRole("menuitem", name="评论管理")` | role | getByText("评论管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_数据概览 | `getByRole("menuitem", name="数据概览")` | role | getByText("数据概览", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_作品分析 | `getByRole("menuitem", name="作品分析")` | role | getByText("作品分析", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_直播数据 | `getByRole("menuitem", name="直播数据")` | role | getByText("直播数据", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_粉丝分析 | `getByRole("menuitem", name="粉丝分析")` | role | getByText("粉丝分析", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_创作灵感 | `getByRole("menuitem", name="创作灵感")` | role | getByText("创作灵感", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_我的灵感 | `getByRole("menuitem", name="我的灵感")` | role | getByText("我的灵感", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_活动中心 | `getByRole("menuitem", name="活动中心")` | role | getByText("活动中心", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_热点榜单 | `getByRole("menuitem", name="热点榜单")` | role | getByText("热点榜单", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_创作学院 | `getByRole("menuitem", name="创作学院")` | role | getByText("创作学院", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_音乐人 | `getByRole("menuitem", name="音乐人")` | role | getByText("音乐人", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_作品推广 | `getByRole("menuitem", name="作品推广")` | role | getByText("作品推广", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_推广资源管理 | `getByRole("menuitem", name="推广资源管理")` | role | getByText("推广资源管理", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |
| menu_sub_创建直播 | `getByRole("menuitem", name="创建直播")` | role | getByText("创建直播", exact=True) / .el-menu-item:visible | {"page": "menu", "checks": [[".el-menu-item:visible", 20, "s… |

### buttons  (14)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| tab_上传视频 | `getByRole("tab", name="上传视频")` | role | getByText("上传视频", exact=True) / #rc-tabs-0-tab-1:visible | {"page": "publish", "checks": [["#rc-tabs-0-tab-1:visible", … |
| tab_上传图文 | `getByRole("tab", name="上传图文")` | role | getByText("上传图文", exact=True) / #rc-tabs-0-tab-2:visible | {"page": "publish", "checks": [["#rc-tabs-0-tab-2:visible", … |
| tab_上传全景视频 | `getByRole("tab", name="上传全景视频")` | role | getByText("上传全景视频", exact=True) / #rc-tabs-0-tab-3:visible | {"page": "publish", "checks": [["#rc-tabs-0-tab-3:visible", … |
| btn_继续编辑 | `getByRole("button", name="继续编辑")` | role | getByText("继续编辑", exact=True) / xpath=//div[@id='joyride-wrapper']/main/section/div[1]/div[2]/button[1] | {"page": "publish", "checks": [["xpath=//div[@id='joyride-wr… |
| btn_放弃 | `getByRole("button", name="放弃")` | role | getByText("放弃", exact=True) / xpath=//div[@id='joyride-wrapper']/main/section/div[1]/div[2]/button[2] | {"page": "publish", "checks": [["xpath=//div[@id='joyride-wr… |
| btn_上传视频 | `getByRole("button", name="上传视频")` | role | getByText("上传视频", exact=True) / xpath=//div[@id='joyride-wrapper']/main/section/div[2]/div[1]/div[2]/button | {"page": "publish", "checks": [["xpath=//div[@id='joyride-wr… |
| btn_立即体验 | `getByRole("button", name="立即体验")` | role | getByText("立即体验", exact=True) / xpath=//div[@id='joyride-wrapper']/main/div/button | {"page": "publish", "checks": [["xpath=//div[@id='joyride-wr… |
| btn_ai_assistant | `getByText("智能文案", exact=True)` | text | #ai-button:visible / xpath=//div[@id='ai-button'] | {"page": "publish_after", "checks": [["#ai-button:visible", … |
| tab_全部作品 | `getByRole("tab", name="全部作品")` | role | getByText("全部作品", exact=True) / #tab-0:visible | {"page": "work_manage", "checks": [["#tab-0:visible", 1, "st… |
| tab_已发布 | `getByRole("tab", name="已发布")` | role | getByText("已发布", exact=True) / #tab-1:visible | {"page": "work_manage", "checks": [["#tab-1:visible", 1, "st… |
| tab_待发布 | `getByRole("tab", name="待发布")` | role | getByText("待发布", exact=True) / #tab-2:visible | {"page": "work_manage", "checks": [["#tab-2:visible", 1, "st… |
| tab_未通过 | `getByRole("tab", name="未通过")` | role | getByText("未通过", exact=True) / #tab-3:visible | {"page": "work_manage", "checks": [["#tab-3:visible", 1, "st… |
| btn_video_pick_item | `.video-item:visible` | css | xpath=//div/div/div[1] | {"page": "select_videos", "checks": [[".video-item:visible",… |
| btn_select_videos | `getByRole("button", name="选择视频")` | role | getByText("选择视频", exact=True) / .el-button:visible | {"page": "comment_manage", "checks": [[".el-button:visible",… |

### regions  (8)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| region_upload_zone | `xpath=//div[@id='joyride-wrapper']/main/section` | xpath |  | {"page": "publish", "checks": [["xpath=//div[@id='joyride-wr… |
| region_work_list_scroll | `.main-container-infinite-list:visible` | css | xpath=//div/div/div[3] | {"page": "work_manage", "checks": [[".main-container-infinit… |
| region_pane_pane-0 | `getByRole("tabpanel")` | role | #pane-0:visible / .el-tab-pane:visible | {"page": "work_manage", "checks": [["#pane-0:visible", 1, "s… |
| region_pane_pane-1 | `getByRole("tabpanel")` | role | #pane-1 / .el-tab-pane:visible | {"page": "work_manage", "checks": [["#pane-1", 1, "static"],… |
| region_pane_pane-2 | `getByRole("tabpanel")` | role | #pane-2 / .el-tab-pane:visible | {"page": "work_manage", "checks": [["#pane-2", 1, "static"],… |
| region_pane_pane-3 | `getByRole("tabpanel")` | role | #pane-3 / .el-tab-pane:visible | {"page": "work_manage", "checks": [["#pane-3", 1, "static"],… |
| region_video_pick_scroll | `getByText("作品列表", exact=True)` | text | .video-list__header:visible / xpath=//div/header | {"page": "select_videos", "checks": [[".video-list__header:v… |
| region_works_analysis_scroll | `.statistics_article_list:visible` | css | xpath=//div | {"page": "data_analysis", "checks": [[".statistics_article_l… |

### textboxes  (1)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| tb_description | `getByPlaceholder("作品描述不会写？试试智能文案")` | placeholder | #work-description-edit:visible / xpath=//div[@id='work-description-edit'] | {"page": "publish_after", "checks": [["#work-description-edi… |

## 小红书  (xiaohongshu)

### menus  (14)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| menu_publish | `getByText("发布笔记", exact=True)` | text | .btn-wrapper:visible / xpath=//div/div[1]/div | {"page": "menu", "checks": [[".btn-wrapper:visible", 1, "sta… |
| menu_首页 | `getByText("首页", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[1] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_笔记管理 | `getByText("笔记管理", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[2] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_数据看板 | `getByText("数据看板", exact=True)` | text | .d-sub-menu:visible / xpath=//div/div[2]/div[1]/div[3] | {"page": "menu", "checks": [[".d-sub-menu:visible", 1, "stat… |
| menu_账号概览 | `getByText("账号概览", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[1] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_内容分析 | `getByText("内容分析", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[2] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_粉丝数据 | `getByText("粉丝数据", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[3] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_活动中心 | `getByText("活动中心", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[4] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_笔记灵感 | `getByText("笔记灵感", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[5] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_创作学院 | `getByText("创作学院", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[6] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_创作百科 | `getByText("创作百科", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[7] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_sub_账号概览 | `getByText("账号概览", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[1] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_sub_内容分析 | `getByText("内容分析", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[2] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |
| menu_sub_粉丝数据 | `getByText("粉丝数据", exact=True)` | text | .d-menu-item:visible / xpath=//div/div[2]/div[1]/div[3]/div[2]/div[3] | {"page": "menu", "checks": [[".d-menu-item:visible", 9, "sta… |

### buttons  (9)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| btn_upload_video | `getByRole("button", name="上传视频")` | role | getByText("上传视频", exact=True) / .d-button:visible | {"page": "publish", "checks": [[".d-button:visible", 1, "sta… |
| btn_topic | `getByRole("button", name="话题")` | role | getByText("话题", exact=True) / #topicBtn:visible | {"page": "publish_after", "checks": [["#topicBtn:visible", 1… |
| btn_用户 | `getByRole("button", name="用户")` | role | getByText("用户", exact=True) / #userBtn:visible | {"page": "publish_after", "checks": [["#userBtn:visible", 1,… |
| btn_表情 | `getByRole("button", name="表情")` | role | getByText("表情", exact=True) / #emoticonsBtn:visible | {"page": "publish_after", "checks": [["#emoticonsBtn:visible… |
| select_添加内容类型声明 | `getByText("添加内容类型声明", exact=True)` | text | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[2]/div[4]/div[1] | {"page": "publish_after", "checks": [[".d-select-wrapper:vis… |
| select_添加地点 | `getByText("添加地点", exact=True)` | text | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[4]/div[1]/div/div | {"page": "publish_after", "checks": [[".d-select-wrapper:vis… |
| select_选择群聊 | `getByText("选择群聊", exact=True)` | text | .d-select-wrapper:visible / xpath=//div/div[1]/div[5]/div[4]/div[2]/div/div | {"page": "publish_after", "checks": [[".d-select-wrapper:vis… |
| select_公开可见 | `getByText("公开可见", exact=True)` | text | .d-select-wrapper:visible / xpath=//div/div[1]/div[6]/div[2]/div[1]/div/div | {"page": "publish_after", "checks": [[".d-select-wrapper:vis… |
| btn_导出数据 | `getByRole("button", name="导出数据")` | role | getByText("导出数据", exact=True) / .d-button:visible | {"page": "data_board", "checks": [[".d-button:visible", 1, "… |

### regions  (5)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| region_upload_zone | `.upload-container:visible` | css | xpath=//div | {"page": "publish", "checks": [[".upload-container:visible",… |
| region_note_list_scroll | `getByText("正在加载中...", exact=True)` | text | #notes-request:visible / .bottom-loading:visible | {"page": "note_manage", "checks": [["#notes-request:visible"… |
| form_笔记题材 | `getByText("笔记题材", exact=True)` | text | .d-form-item__label:visible / xpath=//div/div/div[1]/form/div[1]/div[1] | {"page": "data_board", "checks": [[".d-form-item__label:visi… |
| form_笔记首发时间 | `getByText("笔记首发时间", exact=True)` | text | .d-form-item__label:visible / xpath=//div/div/div[1]/form/div[2]/div[1] | {"page": "data_board", "checks": [[".d-form-item__label:visi… |
| region_data_board_scroll | `.d-table-v2:visible` | css | xpath=//div/div/div[2] | {"page": "data_board", "checks": [[".d-table-v2:visible", 1,… |

### textboxes  (2)

| key | primary | type | fallbacks | evidence |
|---|---|---|---|---|
| tb_title | `getByRole("textbox")` | role | getByPlaceholder("填写标题会有更多赞哦") / .d-text:visible | {"page": "publish_after", "checks": [[".d-text:visible", 13,… |
| tb_description | `getByRole("textbox")` | role | .tiptap:visible / xpath=//div/div[1]/div[3]/div/div[2]/div[1]/div/div | {"page": "publish_after", "checks": [[".tiptap:visible", 1, … |

