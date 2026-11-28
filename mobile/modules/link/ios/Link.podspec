Pod::Spec.new do |s|
  s.name           = 'Link'
  s.version        = '1.0.0'
  s.summary        = "The phone's keys, Face ID and encrypted channel to the Mac"
  s.author         = 'Syncra SRL'
  s.homepage       = 'https://brigadier.sh'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.swift'
end
