Pod::Spec.new do |s|
  s.name             = 'Dimina'
  s.version          = '0.1.0'
  s.summary          = 'DiDi Mini Program Framework'
  
  s.description      = <<-DESC
                      DiDi Mini Program Framework for iOS platform.
                      DESC
                      
  s.homepage         = 'https://github.com/didi/dimina'
  s.license          = { :type => 'Apache-2.0', :file => 'LICENSE' }
  s.author           = { 'Lehem' => 'lehemyang@gmail.com' }
  s.source           = { :git => 'https://github.com/didi/dimina.git', :tag => s.version.to_s }
  
  s.ios.deployment_target = '14.0'
  s.swift_version = '5.0'
  
  s.source_files = 'iOS/dimina/DiminaKit/**/*'
  
  s.resource_bundles = {
    'DiminaAssets' => ['iOS/dimina/Resources/Assets.xcassets'],
    'DiminaJsSdk' => ['shared/jssdk/**/*']
  }
  
  s.frameworks = 'UIKit', 'Foundation'
  
  s.dependency 'MMKV', '2.2.2'
  s.dependency 'SSZipArchive', '2.4.3'
  s.dependency 'Alamofire', '5.10.2'
end 