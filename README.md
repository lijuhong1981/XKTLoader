# XKTLoader

一个加载解析[.xkt](https://github.com/xeokit/xeokit-convert) BIM模型文件的插件，基于[xeokit-sdk](https://github.com/xeokit/xeokit-sdk)源码精简而来，去除了XKTLoaderPlugin对Viewer和Renderer的依赖，只对.xkt文件进行加载和解析，并返回解析后的数据，可以使用其它的Web3D引擎，如Cesium、threejs等，来对数据进行绘制和管理。
