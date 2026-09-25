using Aml.Engine.CAEX;
using Xunit;

namespace Aml.Editor.Plugin.Viewer3D.Tests;

public class SelectionTests
{
    [Fact]
    public void AnInterfaceOrAttributeSelectsTheElementItBelongsTo()
    {
        var document = CAEXDocument.New_CAEXDocument();
        var hierarchy = document.CAEXFile.InstanceHierarchy.Append("IH");
        var element = hierarchy.InternalElement.Append("Robot");
        var child = element.InternalElement.Append("Axis6");
        var iface = child.ExternalInterface.Append("Flange");
        var attribute = child.Attribute.Append("Frame");

        Assert.Equal(child.ID, Viewer3DPlugin.NearestElementId(iface));
        Assert.Equal(child.ID, Viewer3DPlugin.NearestElementId(attribute));
        Assert.Equal(element.ID, Viewer3DPlugin.NearestElementId(element));
        Assert.Null(Viewer3DPlugin.NearestElementId(hierarchy));
    }
}

public class ThemeTests
{
    [Theory]
    [InlineData(0x25, 0x25, 0x25, true)]
    [InlineData(0xF0, 0xF0, 0xF0, false)]
    [InlineData(0x40, 0x40, 0x80, true)]
    public void TheThemeFollowsTheBrightnessOfTheEditorsBackground(byte r, byte g, byte b, bool dark) =>
        Assert.Equal(dark, Viewer3DPlugin.IsDark(new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(r, g, b))));

    [Fact]
    public void WithoutAThemeTheViewIsLight() => Assert.False(Viewer3DPlugin.IsDark(null));
}
