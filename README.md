# XKTLoader

一个加载解析[.xkt](https://github.com/xeokit/xeokit-convert) BIM模型文件的插件，基于[xeokit-sdk](https://github.com/xeokit/xeokit-sdk)源码精简而来，去除了XKTLoaderPlugin对Viewer和Renderer的依赖，只对.xkt文件进行加载和解析，并返回解析后的数据，可以使用其它的Web3D引擎，如Cesium、threejs等，来对数据进行绘制和展示。

## 安装

```js
    npm install @lijuhong1981/xktloader
```

## 使用

```js
    import XKTLoaderPlugin from "@lijuhong1981/xktloader";
    or
    import XKTLoaderPlugin from "@lijuhong1981/xktloader/src/index.js";

    const xktLoader = new XKTLoaderPlugin();
    xktLoader.load({
        id: id,
        src: url,
        edges: true,
        saoEnabled: false,
        dtxEnabled: false
    }, (sceneModel, metaModel) => {
        console.log(sceneModel, metaModel);
    }, (errMsg) => {
        console.error(errMsg);
    });
```

获得sceneModel对象后，遍历_meshList

```js
    for (let i = 0, len = sceneModel._meshList.length; i < len; i++) {
        const mesh = sceneModel._meshList[i];
        console.log(mesh.cfg);
    }
```

mesh.cfg下即可看到positions、normals、uv、color、texture等等模型数据，可使用Cesium或threejs各自对应的绘制接口进行模型绘制
