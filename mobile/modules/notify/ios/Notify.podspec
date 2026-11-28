Pod::Spec.new do |s|
  s.name           = 'Notify'
  s.version        = '1.0.0'
  s.summary        = "The phone's notification key, shared with its notification extension"
  s.author         = 'Syncra SRL'
  s.homepage       = 'https://brigadier.sh'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Service/ is the extension's own, built into its target by plugins/notify.js.
  s.source_files   = 'NotifyModule.swift', 'Sealed.swift'
end
