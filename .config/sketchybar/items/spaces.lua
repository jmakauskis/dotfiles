local colors = require("colors")
local icons = require("icons")
local settings = require("settings")
local app_icons = require("helpers.app_icons")

local spaces = {}

for i = 1, 10, 1 do
  local space = sbar.add("item", "space." .. i, {
    icon = {
      font = { family = settings.font.numbers },
      string = i,
      padding_left = 8,
      padding_right = 4,
      color = colors.white,
      highlight_color = colors.red,
    },
    label = {
      padding_right = 8,
      color = colors.grey,
      highlight_color = colors.white,
      font = "sketchybar-app-font:Regular:16.0",
      y_offset = -1,
    },
    padding_right = 1,
    padding_left = 1,
    updates = true,
    background = {
      color = colors.bg1,
      border_width = 1,
      height = 26,
      border_color = colors.black,
    },
    popup = { background = { border_width = 5, border_color = colors.black } }
  })

  spaces[i] = space

  -- Single item bracket for space items to achieve double border on highlight
  local space_bracket = sbar.add("bracket", { space.name }, {
    background = {
      color = colors.transparent,
      border_color = colors.bg2,
      height = 28,
      border_width = 2
    }
  })

  -- Padding space
  sbar.add("item", "space.padding." .. i, {
    width = settings.group_paddings,
    script = "",
  })

  local space_popup = sbar.add("item", {
    position = "popup." .. space.name,
    padding_left= 5,
    padding_right= 0,
    background = {
      drawing = true,
      image = {
        corner_radius = 9,
        scale = 0.2
      }
    }
  })

  space:subscribe("aerospace_workspace_change", function(env)
    aerospace_focused = env.FOCUSED
    local selected = tostring(i) == env.FOCUSED
    space:set({
      icon = { highlight = selected },
      label = { highlight = selected },
      background = { border_color = selected and colors.black or colors.bg2 }
    })
    space_bracket:set({
      background = { border_color = selected and colors.grey or colors.bg2 }
    })
  end)

  space:subscribe("mouse.clicked", function(env)
    if env.BUTTON == "other" then
      space_popup:set({ background = { image = "space." .. env.SID } })
      space:set({ popup = { drawing = "toggle" } })
    else
      sbar.exec("aerospace workspace " .. i)
    end
  end)

  space:subscribe("mouse.exited", function(_)
    space:set({ popup = { drawing = false } })
  end)
end

local space_window_observer = sbar.add("item", {
  drawing = false,
  updates = true,
})

local aerospace_focused = 1

local spaces_indicator = sbar.add("item", {
  padding_left = -3,
  padding_right = 0,
  icon = {
    padding_left = 8,
    padding_right = 9,
    color = colors.grey,
    string = icons.switch.on,
  },
  label = {
    width = 0,
    padding_left = 0,
    padding_right = 8,
    string = "Spaces",
    color = colors.bg1,
  },
  background = {
    color = colors.with_alpha(colors.grey, 0.0),
    border_color = colors.with_alpha(colors.bg1, 0.0),
  }
})

local function update_space_icons()
  sbar.exec("aerospace list-windows --all --format '%{workspace} %{app-name}'", function(output)
    local workspace_apps = {}
    for line in (output .. "\n"):gmatch("([^\n]*)\n") do
      local ws, app = line:match("^(%S+)%s+(.+)$")
      local ws_num = tonumber(ws)
      if ws_num and ws_num >= 1 and ws_num <= 10 and app then
        if not workspace_apps[ws_num] then workspace_apps[ws_num] = {} end
        -- deduplicate apps per workspace
        local seen = false
        for _, existing in ipairs(workspace_apps[ws_num]) do
          if existing == app then seen = true; break end
        end
        if not seen then table.insert(workspace_apps[ws_num], app) end
      end
    end
    for i = 1, 10 do
      local apps = workspace_apps[i]
      local focused = tostring(i) == tostring(aerospace_focused)
      if apps and #apps > 0 then
        local icon_line = ""
        for _, app in ipairs(apps) do
          local lookup = app_icons[app]
          icon_line = icon_line .. (lookup or app_icons["Default"])
        end
        spaces[i]:set({ drawing = true, label = icon_line })
      elseif focused then
        spaces[i]:set({ drawing = true, label = "" })
      else
        spaces[i]:set({ drawing = false })
      end
    end
  end)
end

space_window_observer:subscribe("aerospace_workspace_change", function(env)
  update_space_icons()
end)

space_window_observer:subscribe("front_app_switched", function(env)
  update_space_icons()
end)

spaces_indicator:subscribe("swap_menus_and_spaces", function(env)
  local currently_on = spaces_indicator:query().icon.value == icons.switch.on
  spaces_indicator:set({
    icon = currently_on and icons.switch.off or icons.switch.on
  })
end)

spaces_indicator:subscribe("mouse.entered", function(env)
  sbar.animate("tanh", 30, function()
    spaces_indicator:set({
      background = {
        color = { alpha = 1.0 },
        border_color = { alpha = 1.0 },
      },
      icon = { color = colors.bg1 },
      label = { width = "dynamic" }
    })
  end)
end)

spaces_indicator:subscribe("mouse.exited", function(env)
  sbar.animate("tanh", 30, function()
    spaces_indicator:set({
      background = {
        color = { alpha = 0.0 },
        border_color = { alpha = 0.0 },
      },
      icon = { color = colors.grey },
      label = { width = 0, }
    })
  end)
end)

spaces_indicator:subscribe("mouse.clicked", function(env)
  sbar.trigger("swap_menus_and_spaces")
end)
